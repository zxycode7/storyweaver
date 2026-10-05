import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorld, createWorldBatches } from '../../src/ai/worldBuilder';
import { parseNovelText } from '../../src/domain/novel';
import type { ModelConfig } from '../../src/ai/client';

const config: ModelConfig = { baseUrl: 'https://api.example.test/v1', apiKey: 'secret', model: 'test' };

afterEach(() => vi.unstubAllGlobals());

function response(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
}

describe('buildWorld', () => {
  it('processes no more than two chapter batches at once', async () => {
    const novel = parseNovelText('第1章\n甲。\n第2章\n乙。\n第3章\n丙。\n第4章\n丁。\n第5章\n戊。\n第6章\n己。\n第7章\n庚。', 'story.txt');
    expect(createWorldBatches(novel).length).toBeGreaterThan(2);
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

    expect(maximumActiveRequests).toBe(2);
  });

  it('resumes from validated checkpointed batch digests instead of re-requesting completed batches', async () => {
    const novel = parseNovelText(
      '第1章 相遇\n林遥经营旧书店。\n第2章 重逢\n周予安再次回来。\n第3章 误会\n两人没有解释。\n第4章 和解\n雨停了。',
      'story.txt',
    );
    const batches = createWorldBatches(novel);
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
    const firstError = await buildWorld(novel, config, (value) => progress.push(value), undefined, store).then(() => undefined, (error: unknown) => error);
    expect(firstError).toBeDefined();
    expect(saved).toBeDefined();
    expect(progress.at(-1)).toMatchObject({ status: 'failed', failedBatch: { number: 2 } });
    failSecondBatch = false;
    await buildWorld(novel, config, undefined, undefined, store);

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
    expect(batches.every((batch) => batch.excerpts.length > 0 && batch.excerpts.length <= 3)).toBe(true);
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
