import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTurnContext, resolveTurn } from '../../src/ai/turnEngine';
import { parseNovelText } from '../../src/domain/novel';
import { createStoryArchive } from '../../src/domain/story';
import type { WorldModel } from '../../src/domain/world';
import type { ModelConfig } from '../../src/ai/client';

const novel = parseNovelText('第1章 相遇\n林遥在书店里等雨停。\n第2章 重逢\n周予安终于回来了，带来当年的信。', 'book.txt');
const source1 = novel.chapters[0].excerpts[0];
const source2 = novel.chapters[1].excerpts[0];
const world: WorldModel = {
  id: 'world', novelId: novel.id, chapterCount: 2, availableExcerptIds: [source1.id], availableExcerptChapters: { [source1.id]: 1 }, premise: '雨夜重逢。', tone: '温柔', narrativeDrivers: ['旧日秘密'],
  characters: [
    { id: 'lin', name: '林遥', summary: '她经营书店。', firstChapter: 1, summaryChapter: 1, sourceExcerptIds: [source1.id] },
    { id: 'zhou', name: '周予安', summary: '他带来了旧信。', firstChapter: 2, summaryChapter: 2, sourceExcerptIds: [source2.id] },
  ],
  facts: [
    { id: 'now', text: '林遥在书店里等雨停。', kind: 'canon', chapterNumber: 1, citations: [source1.id] },
    { id: 'later', text: '周予安带回当年的信。', kind: 'canon', chapterNumber: 2, citations: [source2.id] },
  ], relationships: [], timeline: [], trackedStates: [
    { id: 'trust', label: '信任', description: '彼此信任。', initialValue: 0, introducedChapter: 1, sourceExcerptIds: [source1.id] },
    { id: 'identity_secret', label: '未公开身份', description: '周予安的身份可能另有隐情。', initialValue: '未知', introducedChapter: 2, sourceExcerptIds: [source2.id] },
  ],
  startSuggestions: [{ chapterNumber: 1, label: '雨夜', reason: '关系尚未展开。' }],
};
const archive = createStoryArchive(world, { title: '雨夜', startChapter: 1, difficulty: 'balanced', player: { kind: 'character', characterId: 'lin', name: '林遥' } });
const config: ModelConfig = { baseUrl: 'https://api.example.test/v1', apiKey: 'secret', model: 'test' };

afterEach(() => vi.unstubAllGlobals());

describe('turn engine', () => {
  it('only includes source excerpts and facts up to the current story chapter', () => {
    const context = buildTurnContext(novel, world, archive, '我等雨停后再和她说话。');
    expect(context.sources.every((source) => source.chapterNumber <= archive.chapter)).toBe(true);
    expect(context.prompt).toContain('林遥');
    expect(context.prompt).not.toContain('周予安');
    expect(context.prompt).not.toContain('当年的信');
    expect(context.prompt).not.toContain('identity_secret');
    const afterDivergence = buildTurnContext(novel, world, { ...archive, chapter: 2 }, '我继续观察书店。');
    expect(afterDivergence.prompt).toContain('周予安');
    expect(afterDivergence.prompt).toContain('identity_secret');
    expect(afterDivergence.sources.some((source) => source.chapterNumber === 2)).toBe(true);
  });

  it('returns a validated incremental turn proposal from the configured model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      baseVersion: 0, narration: '雨停以后，林遥把灯打开。', chapter: 1, worldTime: '雨后', changes: [], relevantCharacterIds: ['lin'], changeSummary: [], citations: [source1.id],
    }) } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveTurn(novel, world, archive, '我等雨停。', config);
    expect(result.narration).toContain('把灯打开');
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages[1].content as string;
    expect(sent).not.toContain(source2.id);
  });
});
