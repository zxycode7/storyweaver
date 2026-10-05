import { z } from 'zod';
import type { ModelConfig } from './client';
import { normalizeChatUrl, requestJson } from './client';
import { buildWorldExtractPrompt, buildWorldSynthesisPrompt, WORLD_EXTRACT_SYSTEM, WORLD_SYNTHESIS_SYSTEM, type ChunkDigest, type SourceExcerptContext } from './prompts';
import type { ParsedNovel } from '../domain/novel';
import { validateWorldModel, type WorldCharacter, type WorldFact, type WorldModel, type WorldRelationship, type WorldTimelineEvent } from '../domain/world';
import type { WorldBuildCheckpoint } from '../storage/storyRepository';

export interface WorldBuildProgress {
  completed: number;
  total: number;
  stage: 'reading' | 'synthesizing' | 'complete';
  status?: 'preparing' | 'requesting' | 'retrying' | 'validating' | 'saving' | 'synthesizing' | 'complete' | 'failed';
  activeBatches?: Array<{ number: number; chapterLabel: string; status: 'requesting' | 'retrying' | 'validating' | 'saving'; attempt?: number; maxAttempts?: number; retryDelayMs?: number; errorCode?: string }>;
  resumed?: number;
  chapterCount?: number;
  startedAt?: number;
  errorCode?: string;
  failedBatch?: { number: number; chapterLabel: string; errorCode: string };
}

export type WorldProgressCallback = (progress: WorldBuildProgress) => void;

export interface WorldBatch {
  excerpts: SourceExcerptContext[];
}

const MAX_BATCH_CHARS = 18_000;
const MAX_BATCH_CHAPTERS = 3;
const WORLD_BUILDER_VERSION = 'world-builder-v2';
const EXTRACTION_CONCURRENCY = 2;
const EXTRACTION_RETRIES = 2;

const ChunkDigestSchema = z.object({
  premiseSignal: z.string().max(500).default(''),
  toneNotes: z.array(z.string().max(160)).max(12).default([]),
  narrativeDrivers: z.array(z.string().max(200)).max(12).default([]),
  characters: z.array(z.object({ name: z.string().min(1).max(100), summary: z.string().min(1).max(500), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8).default([]),
  facts: z.array(z.object({ text: z.string().min(1).max(600), kind: z.enum(['canon', 'inference']), confidence: z.number().min(0).max(1).optional(), chapterNumber: z.number().int().positive().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(12).default([]),
  relationships: z.array(z.object({ characterNames: z.array(z.string().min(1).max(100)).min(2).max(8), description: z.string().min(1).max(500), chapterNumber: z.number().int().positive().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8).default([]),
  timeline: z.array(z.object({ description: z.string().min(1).max(500), chapterNumber: z.number().int().positive().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8).default([]),
}).strict();

const SynthesisSchema = z.object({
  premise: z.string().min(1).max(1_200),
  tone: z.string().min(1).max(300),
  narrativeDrivers: z.array(z.string().min(1).max(240)).min(1).max(8),
  trackedStates: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), initialValue: z.union([z.string(), z.number()]), min: z.number().optional(), max: z.number().optional(), citations: z.array(z.string().min(1)).min(1) }).strict()).max(8),
  startSuggestions: z.array(z.object({ chapterNumber: z.number().int().positive(), label: z.string().min(1).max(100), reason: z.string().min(1).max(240) }).strict()).min(1).max(6),
}).strict();

export function createWorldBatches(novel: ParsedNovel): WorldBatch[] {
  const batches: WorldBatch[] = [];
  let current: SourceExcerptContext[] = [];
  let currentChars = 0;
  let chapters = new Set<number>();
  const flush = () => {
    if (current.length) batches.push({ excerpts: current });
    current = [];
    currentChars = 0;
    chapters = new Set<number>();
  };
  for (const chapter of novel.chapters) {
    for (const excerpt of chapter.excerpts) {
      const wouldAddChapter = !chapters.has(chapter.number);
      if (current.length && (currentChars + excerpt.text.length > MAX_BATCH_CHARS || (wouldAddChapter && chapters.size >= MAX_BATCH_CHAPTERS))) flush();
      current.push({ id: excerpt.id, chapterNumber: chapter.number, chapterTitle: chapter.title, text: excerpt.text });
      currentChars += excerpt.text.length;
      chapters.add(chapter.number);
    }
  }
  flush();
  return batches;
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
  const parts = [WORLD_BUILDER_VERSION, novel.id, novel.title, novel.filename, normalizeChatUrl(config.baseUrl), config.model, WORLD_EXTRACT_SYSTEM, WORLD_SYNTHESIS_SYSTEM, buildWorldSynthesisPrompt(novel, [])];
  for (const [index, batch] of batches.entries()) {
    parts.push(String(index), buildWorldExtractPrompt(novel, batch.excerpts));
    for (const excerpt of batch.excerpts) parts.push(String(excerpt.chapterNumber), excerpt.id, excerpt.text);
  }
  let hash = 0xcbf29ce484222325n;
  for (const char of parts.join('\u001f')) {
    hash ^= BigInt(char.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function citationsFor(citations: string[], allowedIds: Set<string>): string[] {
  for (const citation of citations) if (!allowedIds.has(citation)) throw new Error(`模型引用了本批次未提供的原文片段：${citation}`);
  return [...new Set(citations)];
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
  const batches = createWorldBatches(novel);
  const total = batches.length + 1;
  const availableExcerptIds = batches.flatMap((batch) => batch.excerpts.map((excerpt) => excerpt.id));
  const excerptChapters = new Map<string, number>();
  for (const chapter of novel.chapters) for (const excerpt of chapter.excerpts) excerptChapters.set(excerpt.id, chapter.number);
  const normalizeDigest = (parsed: z.infer<typeof ChunkDigestSchema>, batch: WorldBatch, chapterMap: Map<string, number>): ChunkDigest => {
    const allowed = new Set(batch.excerpts.map((excerpt) => excerpt.id));
    return {
      ...parsed,
      characters: parsed.characters.map((character) => ({ ...character, citations: citationsFor(character.citations, allowed) })),
      facts: parsed.facts.map((fact) => {
        const citations = citationsFor(fact.citations, allowed);
        if (fact.kind === 'inference' && fact.confidence === undefined) throw new Error('模型未为一条推断提供可信度。');
        return { ...fact, chapterNumber: chapterFor(citations, chapterMap), citations };
      }),
      relationships: parsed.relationships.map((relation) => {
        const citations = citationsFor(relation.citations, allowed);
        return { ...relation, chapterNumber: chapterFor(citations, chapterMap), citations };
      }),
      timeline: parsed.timeline.map((event) => {
        const citations = citationsFor(event.citations, allowed);
        return { ...event, chapterNumber: chapterFor(citations, chapterMap), citations };
      }),
    };
  };

  const checkpointId = `world-build-${novel.id}`;
  const signature = checkpointSignature(novel, batches, config);
  const digestByIndex: Array<ChunkDigest | undefined> = Array.from({ length: batches.length });
  const durableDigests: Record<string, unknown> = {};
  const startedAt = Date.now();
  const active = new Map<number, NonNullable<WorldBuildProgress['activeBatches']>[number]>();
  let completed = 0;
  let resumed = 0;
  const emit = (patch: Partial<WorldBuildProgress> = {}) => onProgress({
    completed, total, stage: 'reading', status: 'preparing', activeBatches: [...active.values()].sort((a, b) => a.number - b.number),
    resumed, chapterCount: novel.chapters.length, startedAt, ...patch,
  });

  if (checkpointStore) {
    const checkpoint = await checkpointStore.getWorldBuildCheckpoint(checkpointId);
    if (checkpoint && (checkpoint.novelId !== novel.id || checkpoint.signature !== signature)) {
      await checkpointStore.deleteWorldBuildCheckpoint(checkpointId);
    } else if (checkpoint) {
      const storedDigests = checkpoint.digests && typeof checkpoint.digests === 'object' ? checkpoint.digests : {};
      for (const [rawIndex, rawDigest] of Object.entries(storedDigests)) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0 || index >= batches.length) continue;
        try {
          const digest = normalizeDigest(ChunkDigestSchema.parse(rawDigest), batches[index], excerptChapters);
          digestByIndex[index] = digest;
          durableDigests[String(index)] = digest;
          resumed += 1;
        } catch {
          // A damaged digest is ignored and rebuilt from its source batch.
        }
      }
      completed = resumed;
      emit();
    }
  }

  let nextBatchIndex = 0;
  let firstFailure: unknown;
  let firstFailureProgress: Pick<WorldBuildProgress, 'errorCode' | 'failedBatch'> | undefined;
  let persistTail = Promise.resolve();
  const worker = async () => {
    while (!firstFailure) {
      while (nextBatchIndex < batches.length && digestByIndex[nextBatchIndex]) nextBatchIndex += 1;
      if (nextBatchIndex >= batches.length) return;
      const index = nextBatchIndex++;
      const batch = batches[index];
      const batchNumber = index + 1;
      const chapterLabel = batch.excerpts.length === 1
        ? `第 ${batch.excerpts[0].chapterNumber} 章 · ${batch.excerpts[0].chapterTitle}`
        : `第 ${batch.excerpts[0].chapterNumber}-${batch.excerpts.at(-1)!.chapterNumber} 章`;
      active.set(index, { number: batchNumber, chapterLabel, status: 'requesting' });
      emit({ status: 'requesting' });
      try {
        const raw = await requestJson<unknown>(config, {
          system: WORLD_EXTRACT_SYSTEM,
          user: buildWorldExtractPrompt(novel, batch.excerpts),
          signal,
          retry: { maxRetries: EXTRACTION_RETRIES, timeoutMs: 180_000, baseDelayMs: 1_500, maxDelayMs: 12_000 },
          onProgress: (event) => {
            if (event.type === 'attempt-start') {
              active.set(index, { number: batchNumber, chapterLabel, status: 'requesting', attempt: event.attempt, maxAttempts: event.maxAttempts });
              emit({ status: 'requesting' });
            } else if (event.type === 'retry-scheduled') {
              active.set(index, { number: batchNumber, chapterLabel, status: 'retrying', attempt: event.attempt, maxAttempts: event.maxAttempts, retryDelayMs: event.delayMs, errorCode: event.code });
              emit({ status: 'retrying' });
            }
          },
        });
        active.set(index, { number: batchNumber, chapterLabel, status: 'validating' });
        emit({ status: 'validating' });
        const digest = normalizeDigest(ChunkDigestSchema.parse(raw), batch, excerptChapters);
        digestByIndex[index] = digest;
        if (checkpointStore) {
          active.set(index, { number: batchNumber, chapterLabel, status: 'saving' });
          emit({ status: 'saving' });
          persistTail = persistTail.then(async () => {
            const nextDigests = { ...durableDigests, [String(index)]: digest };
            await checkpointStore!.saveWorldBuildCheckpoint({ id: checkpointId, novelId: novel.id, signature, digests: nextDigests, updatedAt: new Date().toISOString() });
            durableDigests[String(index)] = digest;
          });
          await persistTail;
        }
        completed += 1;
        active.delete(index);
        emit({ status: 'preparing' });
      } catch (error) {
        active.delete(index);
        if (!firstFailure) {
          firstFailure = error;
          const errorCode = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown';
          firstFailureProgress = { errorCode, failedBatch: { number: batchNumber, chapterLabel, errorCode } };
        }
      }
    }
  };
  const workerCount = Math.min(EXTRACTION_CONCURRENCY, batches.length - resumed);
  await Promise.all(Array.from({ length: Math.max(0, workerCount) }, () => worker()));
  if (firstFailure) {
    emit({ status: 'failed', ...firstFailureProgress });
    throw firstFailure;
  }

  const digests = digestByIndex as ChunkDigest[];
  emit({ completed: batches.length, stage: 'synthesizing', status: 'synthesizing' });
  let synthesis: z.infer<typeof SynthesisSchema>;
  try {
    synthesis = SynthesisSchema.parse(await requestJson<unknown>(config, {
      system: WORLD_SYNTHESIS_SYSTEM,
      user: buildWorldSynthesisPrompt(novel, digests),
      signal,
      retry: { maxRetries: EXTRACTION_RETRIES, timeoutMs: 180_000, baseDelayMs: 1_500, maxDelayMs: 12_000 },
      onProgress: (event) => {
        if (event.type === 'attempt-start') emit({ completed: batches.length, stage: 'synthesizing', status: 'synthesizing' });
        if (event.type === 'retry-scheduled') emit({ completed: batches.length, stage: 'synthesizing', status: 'retrying', errorCode: event.code });
      },
    }));
  } catch (error) {
    const errorCode = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown';
    const failedBatch = { number: batches.length + 1, chapterLabel: '全书汇总', errorCode };
    emit({ completed: batches.length, stage: 'synthesizing', status: 'failed', errorCode, failedBatch });
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
    trackedStates: synthesis.trackedStates.map((state) => {
      const citations = citationsFor(state.citations, new Set(availableExcerptIds));
      return { ...state, sourceExcerptIds: citations, introducedChapter: chapterFor(citations, excerptChapters) };
    }),
    startSuggestions: synthesis.startSuggestions,
  }, novel);
  onProgress({ completed: total, total, stage: 'complete', status: 'complete', resumed, chapterCount: novel.chapters.length, startedAt });
  return model;
}

export type WorldBuildCheckpointStore = {
  getWorldBuildCheckpoint(id: string): Promise<WorldBuildCheckpoint | undefined>;
  saveWorldBuildCheckpoint(checkpoint: WorldBuildCheckpoint): Promise<void>;
  deleteWorldBuildCheckpoint(id: string): Promise<void>;
};
