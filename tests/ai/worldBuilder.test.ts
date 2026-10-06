import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorld, createWorldBatches, getWorldRequestTimeoutMs } from '../../src/ai/worldBuilder';
import { parseNovelText } from '../../src/domain/novel';
import type { ModelConfig } from '../../src/ai/client';
import { buildWorldSynthesisPrompt, type ChunkDigest } from '../../src/ai/prompts';
import { estimateModelTokens } from '../../src/ai/tokenEstimate';
import type { WorldBuildCheckpoint } from '../../src/storage/storyRepository';

const config: ModelConfig = { baseUrl: 'https://api.example.test/v1', apiKey: 'secret', model: 'test' };

afterEach(() => vi.unstubAllGlobals());

function response(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
}

describe('buildWorld', () => {
  it('allows longer requests as context grows while keeping a hard timeout ceiling', () => {
    expect(getWorldRequestTimeoutMs(20_000)).toBe(180_000);
    expect(getWorldRequestTimeoutMs(192_000)).toBe(300_000);
    expect(getWorldRequestTimeoutMs(1_000_000)).toBe(600_000);
  });

  it('reuses citation-valid saved digests after batch boundaries change', async () => {
    const novel = parseNovelText('第1章\n已经分析过的原文。', 'resume.txt');
    const excerptId = novel.chapters[0].excerpts[0].id;
    let checkpoint: WorldBuildCheckpoint = {
      id: `world-build-${novel.id}`, novelId: novel.id, signature: 'previous-builder-signature', updatedAt: new Date().toISOString(),
      digests: { 0: { premiseSignal: '旧检查点。', characters: [{ name: '林遥', summary: '经营旧书店。', citations: [excerptId] }], facts: [], relationships: [], timeline: [] } },
    };
    const store = {
      getWorldBuildCheckpoint: async () => checkpoint,
      saveWorldBuildCheckpoint: async (value: WorldBuildCheckpoint) => { checkpoint = value; },
      deleteWorldBuildCheckpoint: async () => { checkpoint = undefined as never; },
    };
    let extractionRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages as Array<{ role: string; content: string }>;
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('小说资料分析器')) {
        extractionRequests += 1;
        return response({ characters: [{ name: '新角色', summary: '新整理。', citations: [excerptId] }], facts: [], relationships: [], timeline: [] });
      }
      return response({ premise: '一段故事。', tone: '安静。', narrativeDrivers: ['关系'], trackedStates: [], startSuggestions: [{ chapterNumber: 1, label: '开始', reason: '开场。' }] });
    }));

    await buildWorld(novel, config, undefined, undefined, store);

    expect(extractionRequests).toBe(0);
    expect(checkpoint.signature).not.toBe('previous-builder-signature');
  });

  it('persists inspectable progress without saving API keys or source text', async () => {
    const novel = parseNovelText('第1章\n绝密原文只用于这个测试。', 'secret.txt');
    const secretConfig = { ...config, apiKey: 'private-key-for-diagnostics' };
    let checkpoint: unknown;
    const store = {
      getWorldBuildCheckpoint: async () => undefined,
      saveWorldBuildCheckpoint: async (value: unknown) => { checkpoint = value; },
      deleteWorldBuildCheckpoint: async () => undefined,
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages as Array<{ role: string; content: string }>;
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const prompt = messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('小说资料分析器')) {
        const excerptId = prompt.match(/<source id="([^"]+)"/)?.[1] ?? 'missing';
        return response({ characters: [{ name: '角色', summary: '角色。', citations: [excerptId] }], facts: [], relationships: [], timeline: [] });
      }
      return response({ premise: '一段故事。', tone: '安静。', narrativeDrivers: ['关系'], trackedStates: [], startSuggestions: [{ chapterNumber: 1, label: '开始', reason: '开场。' }] });
    }));

    await buildWorld(novel, secretConfig, undefined, undefined, store);

    const saved = checkpoint as { events?: Array<{ status: string; estimatedTokens?: number; durationMs?: number }> };
    const statuses = saved.events?.map((event) => event.status) ?? [];
    expect(statuses).toEqual(expect.arrayContaining(['requesting', 'validating', 'saving', 'saved', 'synthesizing', 'complete']));
    expect(saved.events?.some((event) => (event.estimatedTokens ?? 0) > 0)).toBe(true);
    expect(JSON.stringify(checkpoint)).not.toMatch(/private-key-for-diagnostics|绝密原文/);
  });

  it('keeps full-book synthesis evidence within its budget while sampling across the book', () => {
    const novel = parseNovelText('第1章\n故事开始。', 'story.txt');
    const digests: ChunkDigest[] = Array.from({ length: 200 }, (_, index) => ({
      premiseSignal: `${index} ${'故事脉络'.repeat(80)}`,
      toneNotes: ['克制温柔'.repeat(20)],
      narrativeDrivers: ['未说出口的话'.repeat(20)],
      characters: [{ name: `人物${index}`, summary: '在故事中做出选择。'.repeat(30), citations: [`excerpt-${index}`] }],
      facts: [{ text: '重要事实。'.repeat(40), kind: 'canon', chapterNumber: index + 1, citations: [`excerpt-${index}`] }],
      relationships: [],
      timeline: [{ description: '关系发生变化。'.repeat(30), chapterNumber: index + 1, citations: [`excerpt-${index}`] }],
    }));
    const prompt = buildWorldSynthesisPrompt(novel, digests, 40_000);

    expect(estimateModelTokens(prompt)).toBeLessThanOrEqual(40_000);
    expect(prompt).toContain('批次 1');
    expect(prompt).toContain('批次 200');
  });

  it('packs small chapters together without the former three-chapter ceiling', () => {
    const text = Array.from({ length: 20 }, (_, index) => `第${index + 1}章 标题\n${'故事'.repeat(1_000)}`).join('\n');
    const novel = parseNovelText(text, 'story.txt');
    const batches = createWorldBatches(novel, 64_000);

    expect(batches.some((batch) => new Set(batch.excerpts.map((excerpt) => excerpt.chapterNumber)).size > 3)).toBe(true);
    expect(batches.every((batch) => batch.estimatedTokens <= 48_000)).toBe(true);
  });

  it('keeps a roughly 6 MiB Chinese novel to a small number of model requests', () => {
    const text = Array.from({ length: 360 }, (_, index) => `第${index + 1}章\n${'主角'.repeat(3_000)}`).join('\n');
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(6 * 1024 * 1024);
    const novel = parseNovelText(text, 'long-story.txt');

    expect(createWorldBatches(novel, 256_000)).toHaveLength(14);
  });

  it('uses four workers for long books while keeping concurrency bounded', async () => {
    const text = Array.from({ length: 12 }, (_, index) => `第${index + 1}章 标题\n${'故事'.repeat(30_000)}`).join('\n');
    const novel = parseNovelText(text, 'story.txt');
    expect(createWorldBatches(novel).length).toBeGreaterThan(4);
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages as Array<{ role: string; content: string }>;
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('小说资料分析器')) {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeRequests -= 1;
        const excerptId = user.match(/<source id="([^"]+)"/)?.[1] ?? 'missing';
        return response({ characters: [{ name: `角色${excerptId.slice(-2)}`, summary: '参与故事。', citations: [excerptId] }], facts: [], relationships: [], timeline: [] });
      }
      return response({ premise: '故事。', tone: '平静。', narrativeDrivers: ['相遇'], trackedStates: [], startSuggestions: [{ chapterNumber: 1, label: '开场', reason: '入口。' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await buildWorld(novel, config);

    expect(maximumActiveRequests).toBe(4);
  });

  it('resumes from validated checkpointed batch digests instead of re-requesting completed batches', async () => {
    const novel = parseNovelText(
      `第1章 相遇\n${'林遥经营旧书店。'.repeat(180)}\n第2章 重逢\n${'周予安再次回来。'.repeat(180)}\n第3章 误会\n${'两人没有解释。'.repeat(180)}\n第4章 和解\n${'雨停了。'.repeat(180)}`,
      'story.txt',
    );
    const resumeConfig = { ...config, contextWindowTokens: 8_000 };
    const batches = createWorldBatches(novel, resumeConfig.contextWindowTokens);
    expect(batches).toHaveLength(2);
    let saved: { id: string; novelId: string; signature: string; digests: Record<string, unknown>; updatedAt: string } | undefined;
    const store = {
      getWorldBuildCheckpoint: async () => saved,
      saveWorldBuildCheckpoint: async (checkpoint: NonNullable<typeof saved>) => { saved = checkpoint; },
      deleteWorldBuildCheckpoint: async (_id: string) => { saved = undefined; },
    };
    let failSecondBatch = true;
    let firstBatchRequests = 0;
    let extractionRequests = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages as Array<{ role: string; content: string }>;
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('小说资料分析器')) {
        extractionRequests += 1;
        const excerptId = user.match(/<source id="([^"]+)"/)?.[1] ?? 'missing';
        if (excerptId === batches[0].excerpts[0].id) firstBatchRequests += 1;
        if (extractionRequests === 1 || (!failSecondBatch && extractionRequests === 3)) {
          return response({ premiseSignal: '已读第一段。', characters: [{ name: '林遥', summary: '经营旧书店。', citations: [excerptId] }], facts: [], relationships: [], timeline: [] });
        }
        if (failSecondBatch) {
          return response({ invalid: true });
        }
        return response({ premiseSignal: '雨停以后。', characters: [{ name: '周予安', summary: '在雨夜回来。', citations: [excerptId] }], facts: [], relationships: [], timeline: [] });
      }
      return response({
        premise: '一段重新开始的故事。', tone: '温柔。', narrativeDrivers: ['关系'], trackedStates: [],
        startSuggestions: [{ chapterNumber: 1, label: '书店', reason: '故事刚开始。' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const progress: Array<{ status?: string; failedBatch?: { number: number; chapterLabel: string } }> = [];
    const firstError = await buildWorld(novel, resumeConfig, (value) => progress.push(value), undefined, store).then(() => undefined, (error: unknown) => error);
    expect(firstError).toBeDefined();
    expect(saved).toBeDefined();
    expect(progress.at(-1)).toMatchObject({ status: 'failed', failedBatch: { number: 2 } });
    failSecondBatch = false;
    await buildWorld(novel, resumeConfig, undefined, undefined, store);

    expect(firstBatchRequests).toBe(1);
    expect(saved).toBeDefined();
    await store.deleteWorldBuildCheckpoint(`world-build-${novel.id}`);
    expect(saved).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps extracted batches when final world synthesis fails', async () => {
    const novel = parseNovelText('第1章 相遇\n林遥经营旧书店。', 'story.txt');
    let saved: { id: string; novelId: string; signature: string; digests: Record<string, unknown>; updatedAt: string } | undefined;
    const store = {
      getWorldBuildCheckpoint: async () => saved,
      saveWorldBuildCheckpoint: async (checkpoint: NonNullable<typeof saved>) => { saved = checkpoint; },
      deleteWorldBuildCheckpoint: async (_id: string) => { saved = undefined; },
    };
    let extractionRequests = 0;
    let synthesisRequests = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages as Array<{ role: string; content: string }>;
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('小说资料分析器')) {
        extractionRequests += 1;
        const excerptId = user.match(/<source id="([^"]+)"/)?.[1] ?? 'missing';
        return response({ characters: [{ name: '林遥', summary: '经营旧书店。', citations: [excerptId] }], facts: [], relationships: [], timeline: [] });
      }
      synthesisRequests += 1;
      if (synthesisRequests === 1) return response({ invalid: true });
      return response({ premise: '雨后的相遇。', tone: '温柔。', narrativeDrivers: ['重逢'], trackedStates: [], startSuggestions: [{ chapterNumber: 1, label: '书店', reason: '相遇。' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(buildWorld(novel, config, undefined, undefined, store)).rejects.toThrow();
    expect(saved).toBeDefined();
    await buildWorld(novel, config, undefined, undefined, store);

    expect(extractionRequests).toBe(1);
    expect(synthesisRequests).toBe(2);
    expect(saved).toBeDefined();
    await store.deleteWorldBuildCheckpoint(`world-build-${novel.id}`);
    expect(saved).toBeUndefined();
  });

  it('keeps batches bounded and compiles cited facts into a playable world', async () => {
    const novel = parseNovelText('第1章 相遇\n林遥经营着一家旧书店。\n第2章 重逢\n周予安在雨夜再次回来。', 'story.txt');
    const batches = createWorldBatches(novel);
    expect(batches.every((batch) => batch.excerpts.length > 0 && batch.estimatedTokens <= 192_000)).toBe(true);
    expect(new Set(batches.flatMap((batch) => batch.excerpts.map((excerpt) => excerpt.chapterNumber)))).toEqual(new Set([1, 2]));
    let supportingExcerpt = '';
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages as Array<{ role: string; content: string }>;
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('小说资料分析器')) {
        const excerptId = user.match(/<source id="([^"]+)"/)?.[1] ?? 'missing';
        supportingExcerpt = excerptId;
        const chapter = Number(user.match(/chapter="(\d+)"/)?.[1] ?? 1);
        return response({
          premiseSignal: '旧书店里的重逢。', toneNotes: ['温柔'], narrativeDrivers: ['没有说出口的话'],
          characters: [{ name: '林遥', summary: '经营旧书店。', citations: [excerptId] }],
          facts: [{ text: '林遥经营一家旧书店。', kind: 'canon', chapterNumber: chapter, citations: [excerptId] }],
          relationships: [], timeline: [],
        });
      }
      return response({
        premise: '一段在旧书店重新开始的故事。', tone: '克制而温柔。', narrativeDrivers: ['未说出口的话'],
        trackedStates: [{ id: 'trust', label: '信任', description: '林遥对玩家的信任。', initialValue: 0, min: 0, max: 5, citations: [supportingExcerpt] }],
        startSuggestions: [{ chapterNumber: 1, label: '雨夜书店', reason: '故事关系刚要展开。' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const progress: Array<{ completed: number; total: number }> = [];
    const world = await buildWorld(novel, config, (value) => progress.push(value));
    expect(world.premise).toContain('旧书店');
    expect(world.chapterCount).toBe(2);
    expect(world.characters[0].name).toBe('林遥');
    expect(world.facts.every((fact) => fact.citations.every((id) => novel.chapters.some((chapter) => chapter.excerpts.some((excerpt) => excerpt.id === id))))).toBe(true);
    expect(progress.at(-1)).toMatchObject({ completed: progress[0].total, total: progress[0].total, stage: 'complete', status: 'complete' });
  });
});
