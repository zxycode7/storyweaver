import type { ParsedNovel } from '../domain/novel';
import type { StoryArchive } from '../domain/story';
import type { WorldModel } from '../domain/world';

const DEFAULT_DATABASE = 'storyweaver-local';
const DATABASE_VERSION = 2;
const STORE_NAMES = ['novels', 'worlds', 'stories', 'worldBuildCheckpoints'] as const;

export interface WorldBuildCheckpoint {
  id: string;
  novelId: string;
  signature: string;
  digests: Record<string, unknown>;
  updatedAt: string;
  events?: WorldBuildEvent[];
  stage?: WorldBuildEventStage;
  status?: WorldBuildEventStatus;
  contextWindowTokens?: number;
  totalBatches?: number;
  completedBatches?: number;
  estimatedTotalTokens?: number;
}

export type WorldBuildEventStage = 'reading' | 'synthesizing' | 'complete';
export type WorldBuildEventStatus = 'preparing' | 'requesting' | 'retrying' | 'validating' | 'saving' | 'saved' | 'synthesizing' | 'complete' | 'failed';

export interface WorldBuildEvent {
  at: string;
  stage: WorldBuildEventStage;
  status: WorldBuildEventStatus;
  batchNumber?: number;
  chapterLabel?: string;
  attempt?: number;
  maxAttempts?: number;
  estimatedTokens?: number;
  timeoutMs?: number;
  durationMs?: number;
  errorCode?: string;
  finishReason?: string;
  responseChars?: number;
  invalidCitationCount?: number;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本机档案读取失败。'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('本机档案保存失败。'));
    transaction.onerror = () => reject(transaction.error ?? new Error('本机档案保存失败。'));
  });
}

export class StoryRepository {
  private connection?: Promise<IDBDatabase>;

  constructor(private readonly databaseName = DEFAULT_DATABASE) {}

  private open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    const connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const storeName of STORE_NAMES) if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error('无法打开本机故事档案。'));
      request.onblocked = () => {
        blocked = true;
        reject(new Error('本机档案正被另一个页面使用，请关闭旧页面后重试。'));
      };
    });
    this.connection = connection;
    void connection.catch(() => {
      if (this.connection === connection) this.connection = undefined;
    });
    return connection;
  }

  async close(): Promise<void> {
    if (this.connection) (await this.connection).close();
    this.connection = undefined;
  }

  private async save<T extends { id: string }>(storeName: typeof STORE_NAMES[number], value: T): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  }

  private async get<T>(storeName: typeof STORE_NAMES[number], id: string): Promise<T | undefined> {
    const database = await this.open();
    const transaction = database.transaction(storeName, 'readonly');
    const result = await requestValue(transaction.objectStore(storeName).get(id)) as T | undefined;
    await transactionDone(transaction);
    return result;
  }

  private async list<T>(storeName: typeof STORE_NAMES[number]): Promise<T[]> {
    const database = await this.open();
    const transaction = database.transaction(storeName, 'readonly');
    const result = await requestValue(transaction.objectStore(storeName).getAll()) as T[];
    await transactionDone(transaction);
    return result;
  }

  async saveNovel(novel: ParsedNovel): Promise<void> { await this.save('novels', novel); }
  async getNovel(id: string): Promise<ParsedNovel | undefined> { return this.get('novels', id); }
  async saveWorld(world: WorldModel): Promise<void> { await this.save('worlds', world); }
  async getWorld(id: string): Promise<WorldModel | undefined> { return this.get('worlds', id); }
  async listWorlds(): Promise<WorldModel[]> { return this.list('worlds'); }
  async saveStory(archive: StoryArchive): Promise<void> { await this.save('stories', archive); }
  async getStory(id: string): Promise<StoryArchive | undefined> { return this.get('stories', id); }
  async listStories(): Promise<StoryArchive[]> {
    return (await this.list<StoryArchive>('stories')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async deleteStory(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction('stories', 'readwrite');
    transaction.objectStore('stories').delete(id);
    await transactionDone(transaction);
  }
  async saveWorldBuildCheckpoint(checkpoint: WorldBuildCheckpoint): Promise<void> {
    await this.save('worldBuildCheckpoints', checkpoint);
  }
  async getWorldBuildCheckpoint(id: string): Promise<WorldBuildCheckpoint | undefined> {
    return this.get('worldBuildCheckpoints', id);
  }
  async listWorldBuildCheckpoints(): Promise<WorldBuildCheckpoint[]> {
    return (await this.list<WorldBuildCheckpoint>('worldBuildCheckpoints')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async deleteWorldBuildCheckpoint(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction('worldBuildCheckpoints', 'readwrite');
    transaction.objectStore('worldBuildCheckpoints').delete(id);
    await transactionDone(transaction);
  }
  async completeWorldBuild(world: WorldModel, checkpointId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(['worlds', 'worldBuildCheckpoints'], 'readwrite');
    transaction.objectStore('worlds').put(world);
    transaction.objectStore('worldBuildCheckpoints').delete(checkpointId);
    await transactionDone(transaction);
  }
}
