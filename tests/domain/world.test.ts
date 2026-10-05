import { describe, expect, it } from 'vitest';
import { parseNovelText } from '../../src/domain/novel';
import { validateWorldModel, type WorldModel } from '../../src/domain/world';

function fixtureWorld(): WorldModel {
  const novel = parseNovelText('第1章 相遇\n雨停后，她推开书店的门。\n第2章 重逢\n两人再次相遇。', 'book.txt');
  const excerpt = novel.chapters[0].excerpts[0];
  return {
    id: 'world-1', novelId: novel.id, chapterCount: novel.chapters.length,
    availableExcerptIds: novel.chapters.flatMap((chapter) => chapter.excerpts.map((item) => item.id)),
    availableExcerptChapters: Object.fromEntries(novel.chapters.flatMap((chapter) => chapter.excerpts.map((item) => [item.id, chapter.number]))),
    premise: '一段迟来的重逢。', tone: '克制、温柔',
    narrativeDrivers: ['未说出口的话'],
    characters: [{ id: 'lin', name: '林遥', summary: '经营旧书店。', firstChapter: 1, summaryChapter: 1, sourceExcerptIds: [excerpt.id] }],
    facts: [{ id: 'fact-1', text: '林遥经营一家旧书店。', kind: 'canon', chapterNumber: 1, citations: [excerpt.id] }, { id: 'inference-1', text: '她可能不愿谈起过去。', kind: 'inference', chapterNumber: 1, citations: [excerpt.id], confidence: 0.4 }],
    relationships: [], timeline: [], trackedStates: [{ id: 'trust', label: '信任', description: '林遥对玩家的信任程度。', initialValue: 0, introducedChapter: 1, sourceExcerptIds: [excerpt.id] }],
    startSuggestions: [{ chapterNumber: 1, label: '雨后的书店', reason: '关系尚未展开。' }],
  };
}

describe('validateWorldModel', () => {
  it('accepts cited canon and keeps inferences separate', () => {
    const novel = parseNovelText('第1章 相遇\n雨停后，她推开书店的门。\n第2章 重逢\n两人再次相遇。', 'book.txt');
    const model = fixtureWorld();
    expect(validateWorldModel(model, novel).facts.map((fact) => fact.kind)).toEqual(['canon', 'inference']);
  });

  it('rejects citations that were not provided by the novel', () => {
    const novel = parseNovelText('第1章 相遇\n雨停后，她推开书店的门。\n第2章 重逢\n两人再次相遇。', 'book.txt');
    const model = fixtureWorld();
    model.facts[0].citations = ['invented-excerpt'];
    expect(() => validateWorldModel(model, novel)).toThrow(/citation|excerpt/i);
  });
});
