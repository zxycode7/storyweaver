import { describe, expect, it } from 'vitest';
import { exportArchive, importArchive } from '../../src/storage/archiveFormat';
import type { StoryArchive } from '../../src/domain/story';
import type { WorldModel } from '../../src/domain/world';

const story: StoryArchive = {
  schemaVersion: 1, id: 'story', worldId: 'world', novelId: 'novel', title: '雨夜',
  player: { kind: 'original', name: '新角色' }, startChapter: 1, chapter: 1,
  difficulty: 'balanced', worldTime: '雨夜', state: { trust: 0 }, turns: [], version: 0,
  createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
};
const world: WorldModel = {
  id: 'world', novelId: 'novel', chapterCount: 1, availableExcerptIds: ['source-id'], availableExcerptChapters: { 'source-id': 1 }, premise: '一段在雨夜开始的故事。', tone: '温柔', narrativeDrivers: ['旧书店'],
  characters: [{ id: 'lin', name: '林遥', summary: '经营一家旧书店。', firstChapter: 1, summaryChapter: 1, sourceExcerptIds: ['source-id'] }],
  facts: [], relationships: [], timeline: [], trackedStates: [], startSuggestions: [{ chapterNumber: 1, label: '雨夜', reason: '故事开始。' }],
};

describe('story archive exchange', () => {
  it('exports only the story and never provider secrets or novel text', async () => {
    const blob = exportArchive(story, world);
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(content).toContain('雨夜');
    expect(content).not.toContain('apiKey');
    expect(content).not.toContain('api.example.com');
    expect(content).not.toContain('原文正文');
    expect(content).toContain('source-id');
    await expect(importArchive(new File([content], 'story.json'))).resolves.toEqual({ story, world });
  });

  it('rejects unknown archive versions and invalid story records', async () => {
    const unknown = new File([JSON.stringify({ format: 'storyweaver-story', version: 99, story, world })], 'future.json');
    await expect(importArchive(unknown)).rejects.toThrow(/版本/);
    const corrupt = new File([JSON.stringify({ format: 'storyweaver-story', version: 1, story: { ...story, chapter: 0 }, world })], 'bad.json');
    await expect(importArchive(corrupt)).rejects.toThrow(/档案|story|章/i);
  });

  it('rejects a saved turn that cites a chapter beyond its story progress', async () => {
    const laterExcerpt = 'later-source-id';
    const worldWithLaterChapter: WorldModel = {
      ...world, chapterCount: 2, availableExcerptIds: ['source-id', laterExcerpt],
      availableExcerptChapters: { 'source-id': 1, [laterExcerpt]: 2 },
    };
    const storyWithFutureCitation: StoryArchive = {
      ...story, version: 1, turns: [{
        id: 'turn-1', action: '我继续往前走。', narration: '未来章节中的原文。', chapter: 1, worldTime: '雨夜',
        changes: [], relevantCharacterIds: [], changeSummary: [], citations: [laterExcerpt], priorState: { trust: 0 },
        priorChapter: 1, priorWorldTime: '雨夜', createdAt: story.updatedAt,
      }],
    };
    const maliciousBundle = new File([JSON.stringify({ format: 'storyweaver-story', version: 1, story: storyWithFutureCitation, world: worldWithLaterChapter })], 'spoiler.json');
    await expect(importArchive(maliciousBundle)).rejects.toThrow(/故事档案/);
  });
});
