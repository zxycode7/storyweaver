import { z } from 'zod';
import type { ModelConfig } from './client';
import { ModelRequestError, normalizeChatUrl, requestJson, type ModelResponseDiagnostics } from './client';
import { buildWorldExtractPrompt, buildWorldSynthesisPrompt, WORLD_EXTRACT_SYSTEM, WORLD_SYNTHESIS_SYSTEM, type ChunkDigest, type SourceExcerptContext } from './prompts';
import type { ParsedNovel } from '../domain/novel';
import { validateWorldModel, type WorldCharacter, type WorldFact, type WorldModel, type WorldRelationship, type WorldTimelineEvent } from '../domain/world';
import type { WorldBuildCheckpoint, WorldBuildEvent } from '../storage/storyRepository';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, estimateModelTokens, getWorldBatchTokenBudget } from './tokenEstimate';

export interface WorldBuildProgress {
  completed: number;
  total: number;
  stage: 'reading' | 'synthesizing' | 'complete';
  status?: 'preparing' | 'requesting' | 'retrying' | 'validating' | 'saving' | 'saved' | 'synthesizing' | 'complete' | 'failed';
  activeBatches?: Array<{ number: number; chapterLabel: string; status: 'requesting' | 'retrying' | 'validating' | 'saving'; attempt?: number; maxAttempts?: number; retryDelayMs?: number; estimatedTokens?: number; timeoutMs?: number; errorCode?: string; finishReason?: string; responseChars?: number; invalidCitationCount?: number }>;
  resumed?: number;
  chapterCount?: number;
  startedAt?: number;
  estimatedTotalTokens?: number;
  events?: WorldBuildEvent[];
  errorCode?: string;
  failedBatch?: { number: number; chapterLabel: string; errorCode: string };
}

export type WorldProgressCallback = (progress: WorldBuildProgress) => void;

export interface WorldBatch {
  excerpts: SourceExcerptContext[];
  estimatedTokens: number;
}

const WORLD_BUILDER_VERSION = 'world-builder-v4-token-batches';
const EXTRACTION_CONCURRENCY = 4;
const EXTRACTION_RETRIES = 2;
const REQUEST_OVERHEAD_TOKENS = 512;

function responseDiagnostics(diagnostics?: ModelResponseDiagnostics): Pick<WorldBuildEvent, 'finishReason' | 'responseChars'> {
  return {
    ...(diagnostics?.finishReason ? { finishReason: diagnostics.finishReason } : {}),
    ...(diagnostics?.responseChars !== undefined ? { responseChars: diagnostics.responseChars } : {}),
  };
}

export function getWorldRequestTimeoutMs(estimatedTokens: number): number {
  const contextSteps = Math.max(0, Math.ceil(estimatedTokens / 64_000) - 1);
  return Math.min(600_000, 180_000 + contextSteps * 60_000);
}

const ChunkDigestSchema = z.object({
  premiseSignal: z.string().max(500).default(''),
  toneNotes: z.array(z.string().max(160)).max(12).default([]),
  narrativeDrivers: z.array(z.string().max(200)).max(12).default([]),
  characters: z.array(z.object({ name: z.string().min(1).max(100), summary: z.string().min(1).max(500), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8).default([]),
  facts: z.array(z.object({ text: z.string().min(1).max(600), kind: z.enum(['canon', 'inference']), confidence: z.number().min(0).max(1).optional(), chapterNumber: z.number().int().positive().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(12).default([]),
  relationships: z.array(z.object({ characterNames: z.array(z.string().min(1).max(100)).min(2).max(8), description: z.string().min(1).max(500), chapterNumber: z.number().int().positive().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8).default([]),
  timeline: z.array(z.object({ description: z.string().min(1).max(500), chapterNumber: z.number().int().positive().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8).default([]),
}).strict();

const SynthesisToneSchema = z.preprocess(
  (value) => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.join('、') : value,
  z.string().min(1).max(300),
);

const SynthesisSchema = z.object({
  premise: z.string().min(1).max(1_200),
  tone: SynthesisToneSchema,
  narrativeDrivers: z.array(z.string().min(1).max(240)).min(1).max(8),
  trackedStates: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), initialValue: z.union([z.string(), z.number()]), min: z.number().optional(), max: z.number().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8),
  startSuggestions: z.array(z.object({ chapterNumber: z.number().int().positive(), label: z.string().min(1).max(100), reason: z.string().min(1).max(240) }).strict()).min(1).max(6),
}).strict();

function estimateBatchHeaderTokens(novel: ParsedNovel, chapters: Set<number>): number {
  const chapterList = [...chapters].join(', ');
  const header = `分析小说《${novel.title}》的指定原文片段。当前批次涉及第 ${chapterList} 章。不要为没出现在本批次的章节编造事实。人物简介只基于该人物在本批次中最早出现的内容。\n\n`;
  return estimateModelTokens(WORLD_EXTRACT_SYSTEM) + estimateModelTokens(header) + REQUEST_OVERHEAD_TOKENS;
}

function estimateSourceTokens(source: SourceExcerptContext): number {
  return estimateModelTokens(`<source id="${source.id}" chapter="${source.chapterNumber}" title="${source.chapterTitle}">\n${source.text}\n</source>\n\n`);
}

export function createWorldBatches(novel: ParsedNovel, contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS): WorldBatch[] {
  const batches: WorldBatch[] = [];
  let current: SourceExcerptContext[] = [];
  let currentChapters = new Set<number>();
  let currentSourceTokens = 0;
  let currentEstimatedTokens = estimateBatchHeaderTokens(novel, currentChapters);
  const flush = () => {
    if (current.length) batches.push({ excerpts: current, estimatedTokens: currentEstimatedTokens });
    current = [];
    currentChapters = new Set<number>();
    currentSourceTokens = 0;
    currentEstimatedTokens = estimateBatchHeaderTokens(novel, currentChapters);
  };
  const budget = getWorldBatchTokenBudget(contextWindowTokens);
  for (const chapter of novel.chapters) {
    for (const excerpt of chapter.excerpts) {
      const source = { id: excerpt.id, chapterNumber: chapter.number, chapterTitle: chapter.title, text: excerpt.text };
      const sourceTokens = estimateSourceTokens(source);
      const candidateChapters = currentChapters.has(chapter.number) ? currentChapters : new Set([...currentChapters, chapter.number]);
      const candidateEstimate = estimateBatchHeaderTokens(novel, candidateChapters) + currentSourceTokens + sourceTokens;
      if (current.length && candidateEstimate > budget) flush();
      current.push(source);
      currentChapters.add(chapter.number);
      currentSourceTokens += sourceTokens;
      currentEstimatedTokens = estimateBatchHeaderTokens(novel, currentChapters) + currentSourceTokens;
    }
  }
  flush();
  return batches;
}

export function countReusableWorldBuildBatches(novel: ParsedNovel, digests: Record<string, unknown>, contextWindowTokens?: number): number {
  const batches = createWorldBatches(novel, contextWindowTokens);
  const batchByExcerpt = new Map<string, number>();
  for (const [index, batch] of batches.entries()) for (const excerpt of batch.excerpts) batchByExcerpt.set(excerpt.id, index);
  const completed = new Set<number>();
  for (const raw of Object.values(digests)) {
    for (const digest of Array.isArray(raw) ? raw : [raw]) {
      if (!digest || typeof digest !== 'object') continue;
      const record = digest as Record<string, unknown>;
      const citations = ['characters', 'facts', 'relationships', 'timeline'].flatMap((field) =>
        Array.isArray(record[field]) ? (record[field] as Array<{ citations?: unknown }>).flatMap((item) => Array.isArray(item?.citations) ? item.citations.filter((id): id is string => typeof id === 'string') : []) : [],
      );
      if (citations.length === 0 || citations.some((id) => !batchByExcerpt.has(id))) continue;
      for (const id of citations) completed.add(batchByExcerpt.get(id)!);
    }
  }
  return completed.size;
}

function key(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function stableHash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

function checkpointSignature(novel: ParsedNovel, batches: WorldBatch[], config: ModelConfig): string {
  const parts = [WORLD_BUILDER_VERSION, novel.id, novel.title, novel.filename, normalizeChatUrl(config.baseUrl), config.model, String(config.contextWindowTokens), WORLD_EXTRACT_SYSTEM, WORLD_SYNTHESIS_SYSTEM, String(novel.chapters.length)];
  for (const [index, batch] of batches.entries()) {
    parts.push(String(index), String(batch.estimatedTokens));
    for (const excerpt of batch.excerpts) parts.push(String(excerpt.chapterNumber), excerpt.chapterTitle, excerpt.id, excerpt.text);
  }
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    first = Math.imul(first ^ 31, 0x01000193);
    second = Math.imul(second ^ 31, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function citationsFor(citations: string[], allowedIds: Set<string>, invalidCitations?: Set<string>): string[] {
  return [...new Set(citations.filter((citation) => {
    if (allowedIds.has(citation)) return true;
    invalidCitations?.add(citation);
    return false;
  }))];
}

function chapterFor(citations: string[], chapterByExcerpt: Map<string, number>): number {
  return Math.max(...citations.map((id) => chapterByExcerpt.get(id) ?? 0));
}

export async function buildWorld(
  novel: ParsedNovel,
  config: ModelConfig,
  onProgress: WorldProgressCallback = () => undefined,
  signal?: AbortSignal,
  checkpointStore?: Pick<WorldBuildCheckpointStore, 'getWorldBuildCheckpoint' | 'saveWorldBuildCheckpoint' | 'deleteWorldBuildCheckpoint'>,
): Promise<WorldModel> {
  if (!novel.chapters.some((chapter) => chapter.excerpts.some((excerpt) => excerpt.text.trim()))) throw new Error('这份小说没有可读取的正文。');
  const batches = createWorldBatches(novel, config.contextWindowTokens);
  const total = batches.length + 1;
  const availableExcerptIds = batches.flatMap((batch) => batch.excerpts.map((excerpt) => excerpt.id));
  const excerptChapters = new Map<string, number>();
  for (const chapter of novel.chapters) for (const excerpt of chapter.excerpts) excerptChapters.set(excerpt.id, chapter.number);
  const normalizeDigest = (parsed: z.infer<typeof ChunkDigestSchema>, batch: WorldBatch, chapterMap: Map<string, number>, invalidCitations?: Set<string>): ChunkDigest => {
    const allowed = new Set(batch.excerpts.map((excerpt) => excerpt.id));
    return {
      ...parsed,
      characters: parsed.characters.flatMap((character) => {
        const citations = citationsFor(character.citations, allowed, invalidCitations);
        return citations.length ? [{ ...character, citations }] : [];
      }),
      facts: parsed.facts.flatMap((fact) => {
        const citations = citationsFor(fact.citations, allowed, invalidCitations);
        if (!citations.length) return [];
        if (fact.kind === 'inference' && fact.confidence === undefined) throw new Error('模型未为一条推断提供可信度。');
        return [{ ...fact, chapterNumber: chapterFor(citations, chapterMap), citations }];
      }),
      relationships: parsed.relationships.flatMap((relation) => {
        const citations = citationsFor(relation.citations, allowed, invalidCitations);
        return citations.length ? [{ ...relation, chapterNumber: chapterFor(citations, chapterMap), citations }] : [];
      }),
      timeline: parsed.timeline.flatMap((event) => {
        const citations = citationsFor(event.citations, allowed, invalidCitations);
        return citations.length ? [{ ...event, chapterNumber: chapterFor(citations, chapterMap), citations }] : [];
      }),
    };
  };

  const checkpointId = `world-build-${novel.id}`;
  const contextWindowTokens = config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const signature = checkpointSignature(novel, batches, { ...config, contextWindowTokens });
  const digestByIndex: Array<ChunkDigest[] | undefined> = Array.from({ length: batches.length });
  const durableDigests: Record<string, unknown> = {};
  const startedAt = Date.now();
  const estimatedTotalTokens = batches.reduce((sum, batch) => sum + batch.estimatedTokens, 0);
  const active = new Map<number, NonNullable<WorldBuildProgress['activeBatches']>[number]>();
  const eventLimit = 500;
  let completed = 0;
  let resumed = 0;
  let stage: WorldBuildProgress['stage'] = 'reading';
  let status: WorldBuildProgress['status'] = 'preparing';
  let events: WorldBuildEvent[] = [];
  let persistTail = Promise.resolve();
  let checkpointWriteError: unknown;
  let checkpoint: WorldBuildCheckpoint = {
    id: checkpointId, novelId: novel.id, signature, digests: {}, updatedAt: new Date().toISOString(),
    contextWindowTokens, totalBatches: batches.length, completedBatches: 0, estimatedTotalTokens,
  };
  const emit = (patch: Partial<WorldBuildProgress> = {}) => onProgress({
    completed, total, stage, status, activeBatches: [...active.values()].sort((a, b) => a.number - b.number),
    resumed, chapterCount: novel.chapters.length, startedAt, estimatedTotalTokens, events, ...patch,
  });
  const saveCheckpoint = (): Promise<void> => {
    if (!checkpointStore) return Promise.resolve();
    checkpoint = {
      ...checkpoint, digests: { ...durableDigests }, events: [...events], stage, status,
      contextWindowTokens, totalBatches: batches.length, completedBatches: Object.keys(durableDigests).length, estimatedTotalTokens, updatedAt: new Date().toISOString(),
    };
    const snapshot = checkpoint;
    const write = persistTail.catch(() => undefined).then(() => checkpointStore.saveWorldBuildCheckpoint(snapshot));
    persistTail = write;
    void write.then(
      () => { if (persistTail === write) checkpointWriteError = undefined; },
      (error) => { checkpointWriteError = error; },
    );
    return write;
  };
  const reportEvent = (event: WorldBuildEvent, patch: Partial<WorldBuildProgress> = {}): Promise<void> => {
    stage = event.stage;
    status = event.status;
    events = [...events, event].slice(-eventLimit);
    emit({ stage, status, events, ...patch });
    return saveCheckpoint();
  };

  if (checkpointStore) {
    const storedCheckpoint = await checkpointStore.getWorldBuildCheckpoint(checkpointId);
    if (storedCheckpoint) {
      const storedDigests = storedCheckpoint.digests && typeof storedCheckpoint.digests === 'object' ? storedCheckpoint.digests : {};
      const batchByExcerpt = new Map<string, number>();
      for (const [index, batch] of batches.entries()) for (const excerpt of batch.excerpts) batchByExcerpt.set(excerpt.id, index);
      let sourceDigests = storedDigests;
      if (storedCheckpoint.novelId === novel.id && storedCheckpoint.signature !== signature) {
        const migrated: Record<string, ChunkDigest[]> = {};
        const partition = <T extends { citations: string[] }>(items: T[], target: number): Array<T & { citations: string[] }> => items.flatMap((item) => {
          if (item.citations.some((id) => !batchByExcerpt.has(id))) return [];
          const citations = item.citations.filter((id) => batchByExcerpt.get(id) === target);
          return citations.length ? [{ ...item, citations }] : [];
        });
        for (const rawDigest of Object.values(storedDigests)) {
          for (const rawPart of Array.isArray(rawDigest) ? rawDigest : [rawDigest]) {
            let parsed: z.infer<typeof ChunkDigestSchema>;
            try { parsed = ChunkDigestSchema.parse(rawPart); } catch { continue; }
            const citations = [
              ...parsed.characters.flatMap((item) => item.citations), ...parsed.facts.flatMap((item) => item.citations),
              ...parsed.relationships.flatMap((item) => item.citations), ...parsed.timeline.flatMap((item) => item.citations),
            ];
            const targets = new Set(citations.map((id) => batchByExcerpt.get(id)).filter((index): index is number => index !== undefined));
            for (const target of targets) {
              const partitioned = {
                ...parsed,
                characters: partition(parsed.characters, target), facts: partition(parsed.facts, target),
                relationships: partition(parsed.relationships, target), timeline: partition(parsed.timeline, target),
              };
              try {
                const normalized = normalizeDigest(ChunkDigestSchema.parse(partitioned), batches[target], excerptChapters);
                (migrated[String(target)] ??= []).push(normalized);
              } catch {
                // Invalid citations are dropped; the affected batch is rebuilt from its source.
              }
            }
          }
        }
        if (storedCheckpoint.novelId === novel.id && Object.keys(migrated).length > 0) {
          sourceDigests = migrated;
          events = Array.isArray(storedCheckpoint.events) ? storedCheckpoint.events.slice(-eventLimit) : [];
          const migrationEvent: WorldBuildEvent = { at: new Date().toISOString(), stage: 'reading', status: 'preparing', chapterLabel: `复核并保留 ${Object.keys(migrated).length} 批旧检查点` };
          events = [...events, migrationEvent].slice(-eventLimit);
          checkpoint = { ...storedCheckpoint, signature, digests: migrated, events, stage: 'reading', status: 'preparing', contextWindowTokens, totalBatches: batches.length, completedBatches: Object.keys(migrated).length, estimatedTotalTokens, updatedAt: new Date().toISOString() };
        } else {
          await checkpointStore.deleteWorldBuildCheckpoint(checkpointId);
        }
      } else if (storedCheckpoint.novelId !== novel.id) {
        await checkpointStore.deleteWorldBuildCheckpoint(checkpointId);
        sourceDigests = {};
      } else {
        checkpoint = storedCheckpoint;
        events = Array.isArray(storedCheckpoint.events) ? storedCheckpoint.events.slice(-eventLimit) : [];
      }
      for (const [rawIndex, rawDigest] of Object.entries(sourceDigests)) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0 || index >= batches.length) continue;
        const normalizedDigests: ChunkDigest[] = [];
        for (const rawPart of Array.isArray(rawDigest) ? rawDigest : [rawDigest]) {
          try { normalizedDigests.push(normalizeDigest(ChunkDigestSchema.parse(rawPart), batches[index], excerptChapters)); }
          catch { /* A damaged digest is ignored and rebuilt from its source batch. */ }
        }
        if (normalizedDigests.length > 0) {
          digestByIndex[index] = normalizedDigests;
          durableDigests[String(index)] = normalizedDigests;
          resumed += 1;
        }
      }
      completed = resumed;
    }
  }

  await reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'preparing', chapterLabel: resumed ? `恢复已保存的 ${resumed} 批` : '整理任务已开始' });

  let nextBatchIndex = 0;
  let firstFailure: unknown;
  let firstFailureProgress: Pick<WorldBuildProgress, 'errorCode' | 'failedBatch'> | undefined;
  let firstFailureEvent: WorldBuildEvent | undefined;
  const worker = async () => {
    while (!firstFailure) {
      while (nextBatchIndex < batches.length && digestByIndex[nextBatchIndex]) nextBatchIndex += 1;
      if (nextBatchIndex >= batches.length) return;
      const index = nextBatchIndex++;
      const batch = batches[index];
      const batchNumber = index + 1;
      const chapterLabel = batch.excerpts.length === 1
        ? `第 ${batch.excerpts[0].chapterNumber} 章`
        : `第 ${batch.excerpts[0].chapterNumber}-${batch.excerpts.at(-1)!.chapterNumber} 章`;
      const batchStartedAt = Date.now();
      const timeoutMs = getWorldRequestTimeoutMs(batch.estimatedTokens);
      let attempts = 1;
      active.set(index, { number: batchNumber, chapterLabel, status: 'requesting', attempt: 1, maxAttempts: EXTRACTION_RETRIES + 1, estimatedTokens: batch.estimatedTokens, timeoutMs });
      try {
        await reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'requesting', batchNumber, chapterLabel, attempt: 1, maxAttempts: EXTRACTION_RETRIES + 1, estimatedTokens: batch.estimatedTokens, timeoutMs });
        const raw = await requestJson<unknown>(config, {
          system: WORLD_EXTRACT_SYSTEM,
          user: buildWorldExtractPrompt(novel, batch.excerpts),
          signal,
          retry: { maxRetries: EXTRACTION_RETRIES, timeoutMs, baseDelayMs: 1_500, maxDelayMs: 12_000 },
          onProgress: (event) => {
            if (event.type === 'attempt-start') {
              attempts = event.attempt;
              active.set(index, { number: batchNumber, chapterLabel, status: 'requesting', attempt: event.attempt, maxAttempts: event.maxAttempts, estimatedTokens: batch.estimatedTokens, timeoutMs });
              void reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'requesting', batchNumber, chapterLabel, attempt: event.attempt, maxAttempts: event.maxAttempts, estimatedTokens: batch.estimatedTokens, timeoutMs }).catch(() => undefined);
            } else if (event.type === 'retry-scheduled') {
              const diagnostics = responseDiagnostics(event.diagnostics);
              active.set(index, { number: batchNumber, chapterLabel, status: 'retrying', attempt: event.attempt, maxAttempts: event.maxAttempts, retryDelayMs: event.delayMs, estimatedTokens: batch.estimatedTokens, timeoutMs, errorCode: event.code, ...diagnostics });
              void reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'retrying', batchNumber, chapterLabel, attempt: event.attempt, maxAttempts: event.maxAttempts, estimatedTokens: batch.estimatedTokens, timeoutMs, errorCode: event.code, ...diagnostics }).catch(() => undefined);
            }
          },
        });
        await persistTail;
        if (checkpointWriteError) throw checkpointWriteError;
        const invalidCitationIds = new Set<string>();
        const digest = normalizeDigest(ChunkDigestSchema.parse(raw), batch, excerptChapters, invalidCitationIds);
        active.set(index, { number: batchNumber, chapterLabel, status: 'validating', attempt: attempts, maxAttempts: EXTRACTION_RETRIES + 1, estimatedTokens: batch.estimatedTokens, timeoutMs, invalidCitationCount: invalidCitationIds.size || undefined });
        await reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'validating', batchNumber, chapterLabel, attempt: attempts, maxAttempts: EXTRACTION_RETRIES + 1, estimatedTokens: batch.estimatedTokens, timeoutMs, durationMs: Date.now() - batchStartedAt, invalidCitationCount: invalidCitationIds.size || undefined });
        digestByIndex[index] = [digest];
        if (checkpointStore) {
          active.set(index, { number: batchNumber, chapterLabel, status: 'saving', estimatedTokens: batch.estimatedTokens });
          await reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'saving', batchNumber, chapterLabel, attempt: attempts, maxAttempts: EXTRACTION_RETRIES + 1, estimatedTokens: batch.estimatedTokens, timeoutMs, durationMs: Date.now() - batchStartedAt });
          durableDigests[String(index)] = [digest];
          await reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'saved', batchNumber, chapterLabel, attempt: attempts, maxAttempts: EXTRACTION_RETRIES + 1, estimatedTokens: batch.estimatedTokens, timeoutMs, durationMs: Date.now() - batchStartedAt });
          if (checkpointWriteError) throw checkpointWriteError;
        } else {
          await reportEvent({ at: new Date().toISOString(), stage: 'reading', status: 'saved', batchNumber, chapterLabel, estimatedTokens: batch.estimatedTokens, durationMs: Date.now() - batchStartedAt });
        }
        completed += 1;
        active.delete(index);
        stage = 'reading';
        status = 'preparing';
        emit();
      } catch (error) {
        active.delete(index);
        if (!firstFailure) {
          firstFailure = error;
          const errorCode = error instanceof ModelRequestError ? error.code : error === checkpointWriteError ? 'local-storage' : 'validation';
          firstFailureProgress = { errorCode, failedBatch: { number: batchNumber, chapterLabel, errorCode } };
          firstFailureEvent = { at: new Date().toISOString(), stage: 'reading', status: 'failed', batchNumber, chapterLabel, estimatedTokens: batch.estimatedTokens, durationMs: Date.now() - batchStartedAt, errorCode, ...responseDiagnostics(error instanceof ModelRequestError ? error.diagnostics : undefined) };
          await reportEvent(firstFailureEvent).catch(() => undefined);
        }
      }
    }
  };
  const workerCount = Math.min(EXTRACTION_CONCURRENCY, batches.length - resumed);
  await Promise.all(Array.from({ length: Math.max(0, workerCount) }, () => worker()));
  if (firstFailure) {
    if (firstFailureEvent && events.at(-1)?.status !== 'failed') {
      await reportEvent({ ...firstFailureEvent, at: new Date().toISOString() }).catch(() => undefined);
    }
    emit({ stage: 'reading', status: 'failed', ...firstFailureProgress });
    throw firstFailure;
  }

  const digests = digestByIndex.flatMap((batchDigests) => batchDigests ?? []);
  const synthesisInputBudget = getWorldBatchTokenBudget(contextWindowTokens) - estimateModelTokens(WORLD_SYNTHESIS_SYSTEM) - REQUEST_OVERHEAD_TOKENS;
  const synthesisPrompt = buildWorldSynthesisPrompt(novel, digests, synthesisInputBudget);
  const synthesisEstimatedTokens = estimateModelTokens(WORLD_SYNTHESIS_SYSTEM) + estimateModelTokens(synthesisPrompt) + REQUEST_OVERHEAD_TOKENS;
  const synthesisTimeoutMs = getWorldRequestTimeoutMs(synthesisEstimatedTokens);
  await reportEvent({ at: new Date().toISOString(), stage: 'synthesizing', status: 'synthesizing', batchNumber: batches.length + 1, chapterLabel: '全书汇总', estimatedTokens: synthesisEstimatedTokens, timeoutMs: synthesisTimeoutMs }, { completed: batches.length });
  let synthesis: z.infer<typeof SynthesisSchema>;
  try {
    const raw = await requestJson<unknown>(config, {
      system: WORLD_SYNTHESIS_SYSTEM,
      user: synthesisPrompt,
      signal,
      retry: { maxRetries: EXTRACTION_RETRIES, timeoutMs: synthesisTimeoutMs, baseDelayMs: 1_500, maxDelayMs: 12_000 },
      onProgress: (event) => {
        if (event.type === 'attempt-start') void reportEvent({ at: new Date().toISOString(), stage: 'synthesizing', status: 'synthesizing', batchNumber: batches.length + 1, chapterLabel: '全书汇总', attempt: event.attempt, maxAttempts: event.maxAttempts, estimatedTokens: synthesisEstimatedTokens, timeoutMs: synthesisTimeoutMs }, { completed: batches.length }).catch(() => undefined);
        if (event.type === 'retry-scheduled') void reportEvent({ at: new Date().toISOString(), stage: 'synthesizing', status: 'retrying', batchNumber: batches.length + 1, chapterLabel: '全书汇总', attempt: event.attempt, maxAttempts: event.maxAttempts, estimatedTokens: synthesisEstimatedTokens, timeoutMs: synthesisTimeoutMs, errorCode: event.code, ...responseDiagnostics(event.diagnostics) }, { completed: batches.length, errorCode: event.code }).catch(() => undefined);
      },
    });
    await persistTail;
    if (checkpointWriteError) throw checkpointWriteError;
    await reportEvent({ at: new Date().toISOString(), stage: 'synthesizing', status: 'validating', batchNumber: batches.length + 1, chapterLabel: '全书汇总', estimatedTokens: synthesisEstimatedTokens });
    synthesis = SynthesisSchema.parse(raw);
  } catch (error) {
    const errorCode = error instanceof ModelRequestError ? error.code : error === checkpointWriteError ? 'local-storage' : 'validation';
    const failedBatch = { number: batches.length + 1, chapterLabel: '全书汇总', errorCode };
    await reportEvent({ at: new Date().toISOString(), stage: 'synthesizing', status: 'failed', batchNumber: batches.length + 1, chapterLabel: '全书汇总', estimatedTokens: synthesisEstimatedTokens, errorCode, ...responseDiagnostics(error instanceof ModelRequestError ? error.diagnostics : undefined) }, { completed: batches.length, failedBatch }).catch(() => undefined);
    throw error;
  }

  const characterMap = new Map<string, WorldCharacter>();
  const facts: WorldFact[] = [];
  const factKeys = new Set<string>();
  const relationMap = new Map<string, WorldRelationship>();
  const timeline: WorldTimelineEvent[] = [];
  for (const digest of digests) {
    for (const character of digest.characters) {
      const citations = [...new Set(character.citations)];
      const earliest = Math.min(...citations.map((id) => excerptChapters.get(id) ?? novel.chapters.length + 1));
      const characterKey = key(character.name);
      const existing = characterMap.get(characterKey);
      if (!existing) {
        const summarySources = citations.filter((id) => excerptChapters.get(id) === earliest);
        characterMap.set(characterKey, {
          id: `character-${stableHash(characterKey)}`, name: character.name, summary: character.summary,
          firstChapter: earliest, summaryChapter: earliest, sourceExcerptIds: summarySources,
        });
      } else if (earliest < existing.firstChapter) {
        existing.firstChapter = earliest;
        existing.summaryChapter = earliest;
        existing.summary = character.summary;
        existing.sourceExcerptIds = citations.filter((id) => excerptChapters.get(id) === earliest);
      }
    }
    for (const fact of digest.facts) {
      const dedupeKey = `${fact.kind}:${key(fact.text)}`;
      if (factKeys.has(dedupeKey)) continue;
      factKeys.add(dedupeKey);
      facts.push({ id: `fact-${stableHash(dedupeKey)}`, text: fact.text, kind: fact.kind, chapterNumber: fact.chapterNumber, citations: fact.citations, ...(fact.confidence === undefined ? {} : { confidence: fact.confidence }) });
    }
    for (const relation of digest.relationships) {
      const ids = relation.characterNames.map((name) => characterMap.get(key(name))?.id).filter((id): id is string => Boolean(id));
      if (ids.length < 2) continue;
      const relationKey = `${[...ids].sort().join(':')}:${key(relation.description)}`;
      if (!relationMap.has(relationKey)) relationMap.set(relationKey, { id: `relation-${stableHash(relationKey)}`, characterIds: [...new Set(ids)], description: relation.description, chapterNumber: relation.chapterNumber ?? 1, citations: relation.citations });
    }
    for (const event of digest.timeline) {
      const eventKey = `${event.chapterNumber}:${key(event.description)}`;
      if (timeline.some((candidate) => `${candidate.chapterNumber}:${key(candidate.description)}` === eventKey)) continue;
      timeline.push({ id: `event-${stableHash(eventKey)}`, description: event.description, chapterNumber: event.chapterNumber ?? 1, citations: event.citations });
    }
  }

  const characters = [...characterMap.values()].slice(0, 80);
  const characterIds = new Set(characters.map((character) => character.id));
  const model = validateWorldModel({
    id: `world-${novel.id.replace(/^novel-/, '')}`,
    novelId: novel.id,
    chapterCount: novel.chapters.length,
    availableExcerptIds,
    availableExcerptChapters: Object.fromEntries(availableExcerptIds.map((id) => [id, excerptChapters.get(id)!])),
    premise: synthesis.premise,
    tone: synthesis.tone,
    narrativeDrivers: synthesis.narrativeDrivers,
    characters,
    facts: facts.slice(0, 500),
    relationships: [...relationMap.values()].filter((relation) => relation.characterIds.every((id) => characterIds.has(id))).slice(0, 300),
    timeline: timeline.slice(0, 300),
    trackedStates: synthesis.trackedStates.flatMap((state) => {
      const citations = citationsFor(state.citations, new Set(availableExcerptIds));
      return citations.length ? [{ ...state, sourceExcerptIds: citations, introducedChapter: chapterFor(citations, excerptChapters) }] : [];
    }),
    startSuggestions: synthesis.startSuggestions,
  }, novel);
  await reportEvent({ at: new Date().toISOString(), stage: 'complete', status: 'complete', chapterLabel: '世界模型已生成', durationMs: Date.now() - startedAt }, { completed: total, total });
  return model;
}

export type WorldBuildCheckpointStore = {
  getWorldBuildCheckpoint(id: string): Promise<WorldBuildCheckpoint | undefined>;
  saveWorldBuildCheckpoint(checkpoint: WorldBuildCheckpoint): Promise<void>;
  deleteWorldBuildCheckpoint(id: string): Promise<void>;
};
