import { describe, expect, it } from 'vitest';
import { applyTurnProposal, createStoryArchive, undoLastTurn, validateStoryAgainstWorld, validateStoryArchive, type TurnProposal } from '../../src/domain/story';
import type { WorldModel } from '../../src/domain/world';

const world: WorldModel = {
  id: 'world', novelId: 'novel', chapterCount: 2, availableExcerptIds: ['source-1'], availableExcerptChapters: { 'source-1': 1 }, premise: '两人重逢。', tone: '温柔', narrativeDrivers: ['未说出口的话'],
  characters: [{ id: 'lin', name: '林遥', summary: '旧书店老板。', firstChapter: 1, summaryChapter: 1, sourceExcerptIds: ['source-1'] }],
  facts: [], relationships: [], timeline: [],
  trackedStates: [
    { id: 'trust', label: '信任', description: '林遥对玩家的信任。', initialValue: 0, min: -3, max: 3, introducedChapter: 1, sourceExcerptIds: ['source-1'] },
    { id: 'identity_secret', label: '隐藏身份', description: '某人身份尚未揭露。', initialValue: '未知', introducedChapter: 2, sourceExcerptIds: ['source-2'] },
  ],
  startSuggestions: [{ chapterNumber: 1, label: '书店', reason: '从相遇开始。' }],
};

const initial = createStoryArchive(world, {
  title: '雨停以后', startChapter: 1, difficulty: 'balanced',
  player: { kind: 'character', characterId: 'lin', name: '林遥' },
});

const proposal: TurnProposal = {
  baseVersion: 0, narration: '她没有立即回答，只把杯子推近了一些。', chapter: 1, worldTime: '雨后傍晚',
  changes: [{ key: 'trust', value: 1, reason: '玩家耐心听她说完。' }],
  relevantCharacterIds: ['lin'], changeSummary: ['林遥对你的信任有所增加。'], citations: ['source-1'],
};

describe('story archive transitions', () => {
  it('applies only defined state changes and increments the version', () => {
    expect(initial.state).toEqual({ trust: 0 });
    const next = applyTurnProposal(initial, proposal, world);
    expect(next.version).toBe(1);
    expect(next.state.trust).toBe(1);
    expect(next.turns[0].narration).toContain('杯子');
  });

  it('rejects stale turns and undefined state fields without mutating the archive', () => {
    const changed = { ...initial, version: 1 };
    expect(() => applyTurnProposal(changed, proposal, world)).toThrow(/stale|版本/i);
    expect(() => applyTurnProposal(initial, { ...proposal, changes: [{ key: 'mood', value: '很开心', reason: '新状态' }] }, world)).toThrow(/state|状态/i);
    expect(initial.version).toBe(0);
  });

  it('rejects a story start beyond the imported novel', () => {
    expect(() => createStoryArchive(world, {
      title: '越界', startChapter: 5, difficulty: 'balanced', player: { kind: 'original', name: '新人物' },
    })).toThrow(/起点|章节/);
  });

  it('rejects archived citations that exceed the story progress chapter', () => {
    const worldWithLaterExcerpt: WorldModel = {
      ...world,
      availableExcerptIds: ['source-1', 'source-2'],
      availableExcerptChapters: { 'source-1': 1, 'source-2': 2 },
      trackedStates: world.trackedStates,
    };
    const laterCitation: TurnProposal = { ...proposal, citations: ['source-2'] };
    const advancedArchive = { ...initial, chapter: 2 };
    const next = applyTurnProposal(advancedArchive, { ...laterCitation, baseVersion: 0, chapter: 2 }, worldWithLaterExcerpt);
    expect(() => validateStoryAgainstWorld(next, worldWithLaterExcerpt)).not.toThrow();
    const corruptedTurn = { ...next, turns: next.turns.map((turn) => ({ ...turn, chapter: 1 })) };
    expect(() => validateStoryAgainstWorld(corruptedTurn, worldWithLaterExcerpt)).toThrow(/故事进度/);
  });

  it('undo restores the exact previous dynamic state', () => {
    const next = applyTurnProposal(initial, proposal, world);
    const undone = undoLastTurn(next);
    expect(undone.version).toBe(0);
    expect(undone.state).toEqual(initial.state);
    expect(undone.turns).toHaveLength(0);
  });

  it('activates state definitions when the story advances into their source chapter', () => {
    const reachedChapterTwo = applyTurnProposal(initial, { ...proposal, chapter: 2 }, world);
    const nextProposal: TurnProposal = {
      ...proposal, baseVersion: reachedChapterTwo.version, chapter: 2,
      changes: [{ key: 'identity_secret', value: '被主角发现', reason: '线索在此章出现。' }],
      citations: ['source-2'],
    };
    const next = applyTurnProposal(reachedChapterTwo, nextProposal, world);
    expect(next.state.identity_secret).toBe('被主角发现');
  });

  it('migrates locally saved story archives from the previous spoilerCeiling schema', () => {
    const legacy = { ...initial, spoilerCeiling: 1 };
    expect(validateStoryArchive(legacy)).not.toHaveProperty('spoilerCeiling');
  });
});
