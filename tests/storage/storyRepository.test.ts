import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryRepository } from '../../src/storage/storyRepository';
import type { ParsedNovel } from '../../src/domain/novel';
import type { StoryArchive } from '../../src/domain/story';
import type { WorldModel } from '../../src/domain/world';

const novel: ParsedNovel = { id: 'novel', filename: 'book.txt', title: '书', charCount: 4, chapters: [] };
const world: WorldModel = {
  id: 'world', novelId: 'novel', chapterCount: 1, availableExcerptIds: ['source'], availableExcerptChapters: { source: 1 }, premise: '一个故事', tone: '温柔', narrativeDrivers: ['关系'],
  characters: [{ id: 'c', name: '林遥', summary: '经营书店。', firstChapter: 1, summaryChapter: 1, sourceExcerptIds: ['source'] }], facts: [], relationships: [], timeline: [], trackedStates: [],
  startSuggestions: [{ chapterNumber: 1, label: '书店', reason: '相遇。' }],
};
const story: StoryArchive = {
  schemaVersion: 1, id: 'story', worldId: 'world', novelId: 'novel', title: '雨夜',
  player: { kind: 'original', name: '新角色' }, startChapter: 1, chapter: 1,
  difficulty: 'balanced', worldTime: '雨夜', state: {}, turns: [], version: 0,
  createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
};

async function seedVersionOneDatabase(): Promise<void> {
  const request = indexedDB.open('storyweaver-test', 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore('novels', { keyPath: 'id' });
    database.createObjectStore('worlds', { keyPath: 'id' });
    database.createObjectStore('stories', { keyPath: 'id' });
  };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['novels', 'worlds', 'stories'], 'readwrite');
    transaction.objectStore('novels').put(novel);
    transaction.objectStore('worlds').put(world);
    transaction.objectStore('stories').put(story);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

beforeEach(async () => {
  indexedDB.deleteDatabase('storyweaver-test');
});

describe('StoryRepository', () => {
  it('persists novels, world models, and stories across repository instances', async () => {
    const repository = new StoryRepository('storyweaver-test');
    await repository.saveNovel(novel);
    await repository.saveWorld(world);
    await repository.saveStory(story);
    const reopened = new StoryRepository('storyweaver-test');
    await expect(reopened.getNovel('novel')).resolves.toEqual(novel);
    await expect(reopened.getWorld('world')).resolves.toEqual(world);
    await expect(reopened.getStory('story')).resolves.toEqual(story);
  });

  it('lists stories newest first and deletes only the selected story', async () => {
    const repository = new StoryRepository('storyweaver-test');
    await repository.saveStory(story);
    await repository.saveStory({ ...story, id: 'story-2', updatedAt: '2026-10-06T00:00:00.000Z' });
    expect((await repository.listStories()).map((item) => item.id)).toEqual(['story-2', 'story']);
    await repository.deleteStory('story-2');
    expect((await repository.listStories()).map((item) => item.id)).toEqual(['story']);
  });

  it('migrates a version 1 database while preserving existing novels, worlds, and stories', async () => {
    await seedVersionOneDatabase();
    const repository = new StoryRepository('storyweaver-test');

    await expect(repository.getNovel('novel')).resolves.toEqual(novel);
    await expect(repository.getWorld('world')).resolves.toEqual(world);
    await expect(repository.getStory('story')).resolves.toEqual(story);
    await expect(repository.saveWorldBuildCheckpoint({
      id: 'build', novelId: novel.id, signature: 'sig', digests: { chapter1: 'hash' }, updatedAt: '2026-10-06T00:00:00.000Z',
    })).resolves.toBeUndefined();
  });

  it('saves, retrieves, and deletes opaque world-build checkpoints', async () => {
    const repository = new StoryRepository('storyweaver-test');
    const checkpoint = {
      id: 'build', novelId: novel.id, signature: 'sig', digests: { chapter1: { digest: 'hash', status: 'done' } }, updatedAt: '2026-10-06T00:00:00.000Z',
    };

    await repository.saveWorldBuildCheckpoint(checkpoint);
    await expect(repository.getWorldBuildCheckpoint('build')).resolves.toEqual(checkpoint);
    await repository.deleteWorldBuildCheckpoint('build');
    await expect(repository.getWorldBuildCheckpoint('build')).resolves.toBeUndefined();
  });

  it('lists pending world builds newest first so the home screen can offer recovery after reload', async () => {
    const repository = new StoryRepository('storyweaver-test');
    const older = { id: 'build-old', novelId: 'novel', signature: 'old', digests: {}, updatedAt: '2026-10-05T00:00:00.000Z' };
    const newer = { id: 'build-new', novelId: 'novel-2', signature: 'new', digests: {}, updatedAt: '2026-10-06T00:00:00.000Z' };
    await repository.saveWorldBuildCheckpoint(older);
    await repository.saveWorldBuildCheckpoint(newer);

    await expect(repository.listWorldBuildCheckpoints()).resolves.toEqual([newer, older]);
  });

  it('saves a completed world and removes its checkpoint atomically', async () => {
    const repository = new StoryRepository('storyweaver-test');
    await repository.saveWorldBuildCheckpoint({ id: 'world-build-novel', novelId: novel.id, signature: 'sig', digests: { 0: {} }, updatedAt: '2026-10-06T00:00:00.000Z' });

    await repository.completeWorldBuild(world, 'world-build-novel');

    await expect(repository.getWorld('world')).resolves.toEqual(world);
    await expect(repository.getWorldBuildCheckpoint('world-build-novel')).resolves.toBeUndefined();
  });

  it('allows the same repository instance to retry after a failed database open', async () => {
    const repository = new StoryRepository('storyweaver-test');
    const originalOpen = indexedDB.open.bind(indexedDB);
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new Error('transient open failure');
    }).mockImplementation((...args: Parameters<typeof indexedDB.open>) => originalOpen(...args));

    await expect(repository.getNovel('novel')).rejects.toThrow('transient open failure');
    await expect(repository.getNovel('novel')).resolves.toBeUndefined();
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('closes a database connection that arrives after a blocked upgrade already rejected', async () => {
    const repository = new StoryRepository('storyweaver-test');
    const originalOpen = indexedDB.open.bind(indexedDB);
    const lateConnection = { close: vi.fn(), onversionchange: null };
    const request = { result: undefined as unknown, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null as null | (() => void), onblocked: null as null | (() => void) };
    vi.spyOn(indexedDB, 'open').mockReturnValueOnce(request as unknown as IDBOpenDBRequest).mockImplementation((...args: Parameters<typeof indexedDB.open>) => originalOpen(...args));

    const blockedRead = repository.getNovel('novel');
    request.onblocked?.();
    await expect(blockedRead).rejects.toThrow(/另一个页面/);
    request.result = lateConnection;
    request.onsuccess?.();

    await expect(repository.getNovel('novel')).resolves.toBeUndefined();
    expect(lateConnection.close).toHaveBeenCalledOnce();
  });
});
