import { z } from 'zod';
import type { ParsedNovel } from './novel';

export type FactKind = 'canon' | 'inference';

export interface WorldCharacter {
  id: string;
  name: string;
  summary: string;
  firstChapter: number;
  summaryChapter: number;
  sourceExcerptIds: string[];
}

export interface WorldFact {
  id: string;
  text: string;
  kind: FactKind;
  chapterNumber: number;
  citations: string[];
  confidence?: number;
}

export interface WorldRelationship {
  id: string;
  characterIds: string[];
  description: string;
  chapterNumber: number;
  citations: string[];
}

export interface WorldTimelineEvent {
  id: string;
  description: string;
  chapterNumber: number;
  citations: string[];
}

export interface TrackedStateDefinition {
  id: string;
  label: string;
  description: string;
  initialValue: string | number;
  introducedChapter: number;
  sourceExcerptIds: string[];
  min?: number;
  max?: number;
}

export interface StartSuggestion {
  chapterNumber: number;
  label: string;
  reason: string;
}

export interface WorldModel {
  id: string;
  novelId: string;
  chapterCount: number;
  availableExcerptIds: string[];
  availableExcerptChapters: Record<string, number>;
  premise: string;
  tone: string;
  narrativeDrivers: string[];
  characters: WorldCharacter[];
  facts: WorldFact[];
  relationships: WorldRelationship[];
  timeline: WorldTimelineEvent[];
  trackedStates: TrackedStateDefinition[];
  startSuggestions: StartSuggestion[];
}

const WorldModelSchema = z.object({
  id: z.string().min(1),
  novelId: z.string().min(1),
  chapterCount: z.number().int().positive(),
  availableExcerptIds: z.array(z.string().min(1)).min(1),
  availableExcerptChapters: z.record(z.number().int().positive()),
  premise: z.string().min(1).max(1_200),
  tone: z.string().min(1).max(300),
  narrativeDrivers: z.array(z.string().min(1).max(240)).min(1).max(8),
  characters: z.array(z.object({
    id: z.string().min(1).max(80), name: z.string().min(1).max(100), summary: z.string().min(1).max(500),
    firstChapter: z.number().int().positive(), summaryChapter: z.number().int().positive(), sourceExcerptIds: z.array(z.string().min(1)).min(1),
  })).min(1).max(80),
  facts: z.array(z.object({
    id: z.string().min(1).max(100), text: z.string().min(1).max(600), kind: z.enum(['canon', 'inference']),
    chapterNumber: z.number().int().positive(), citations: z.array(z.string().min(1)).min(1),
    confidence: z.number().min(0).max(1).optional(),
  })).max(500),
  relationships: z.array(z.object({
    id: z.string().min(1).max(100), characterIds: z.array(z.string().min(1)).min(2).max(8),
    description: z.string().min(1).max(500), chapterNumber: z.number().int().positive(), citations: z.array(z.string().min(1)).min(1),
  })).max(300),
  timeline: z.array(z.object({
    id: z.string().min(1).max(100), description: z.string().min(1).max(500),
    chapterNumber: z.number().int().positive(), citations: z.array(z.string().min(1)).min(1),
  })).max(300),
  trackedStates: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), label: z.string().min(1).max(40),
    description: z.string().min(1).max(240), initialValue: z.union([z.string().max(100), z.number()]),
    min: z.number().optional(), max: z.number().optional(), introducedChapter: z.number().int().positive(), sourceExcerptIds: z.array(z.string().min(1)).min(1),
  })).max(20),
  startSuggestions: z.array(z.object({
    chapterNumber: z.number().int().positive(), label: z.string().min(1).max(100), reason: z.string().min(1).max(240),
  })).min(1).max(8),
}).strict();

export function validateWorldModel(value: unknown, novel: ParsedNovel): WorldModel {
  const world = validateWorldSnapshot(value);
  if (world.novelId !== novel.id) throw new Error('世界资料与当前小说不匹配。');
  if (world.chapterCount !== novel.chapters.length) throw new Error('世界资料的章节数量与当前小说不匹配。');
  const excerptChapters = new Map<string, number>();
  for (const chapter of novel.chapters) for (const excerpt of chapter.excerpts) excerptChapters.set(excerpt.id, chapter.number);
  for (const id of world.availableExcerptIds) if (!excerptChapters.has(id)) throw new Error(`世界资料包含不存在的原文片段：${id}`);
  for (const id of world.availableExcerptIds) {
    if (world.availableExcerptChapters[id] !== excerptChapters.get(id)) throw new Error(`世界资料中原文片段 ${id} 的章节范围无效。`);
  }
  if (Object.keys(world.availableExcerptChapters).some((id) => !world.availableExcerptIds.includes(id))) throw new Error('世界资料章节索引包含未开放的原文片段。');

  const checkCitations = (citations: string[], chapterNumber: number) => {
    for (const id of citations) {
      const sourceChapter = excerptChapters.get(id);
      if (sourceChapter === undefined) throw new Error(`世界资料引用了不存在的原文片段：${id}`);
      if (sourceChapter > chapterNumber) throw new Error(`世界资料的第 ${chapterNumber} 章信息引用了更后的章节。`);
    }
  };

  for (const character of world.characters) {
    if (character.firstChapter > novel.chapters.length || character.summaryChapter > novel.chapters.length || character.summaryChapter < character.firstChapter) throw new Error(`角色 ${character.name} 的章节信息无效。`);
    checkCitations(character.sourceExcerptIds, character.summaryChapter);
  }
  const characterIds = new Set(world.characters.map((character) => character.id));
  for (const fact of world.facts) {
    if (fact.chapterNumber > novel.chapters.length) throw new Error('事实引用了不存在的章节。');
    checkCitations(fact.citations, fact.chapterNumber);
    if (fact.kind === 'inference' && fact.confidence === undefined) throw new Error('推断必须包含可信度。');
  }
  for (const relation of world.relationships) {
    checkCitations(relation.citations, relation.chapterNumber);
    if (relation.characterIds.some((id) => !characterIds.has(id))) throw new Error('人物关系引用了不存在的角色。');
  }
  for (const event of world.timeline) checkCitations(event.citations, event.chapterNumber);
  for (const state of world.trackedStates) {
    if (state.introducedChapter > novel.chapters.length) throw new Error(`状态 ${state.id} 的出现章节无效。`);
    checkCitations(state.sourceExcerptIds, state.introducedChapter);
    if (typeof state.initialValue === 'number' && state.min !== undefined && state.initialValue < state.min) throw new Error(`状态 ${state.id} 初始值低于下限。`);
    if (typeof state.initialValue === 'number' && state.max !== undefined && state.initialValue > state.max) throw new Error(`状态 ${state.id} 初始值高于上限。`);
    if (state.min !== undefined && state.max !== undefined && state.min > state.max) throw new Error(`状态 ${state.id} 的范围无效。`);
  }
  const available = new Set(world.availableExcerptIds);
  const allReferences = [
    ...world.characters.flatMap((character) => character.sourceExcerptIds),
    ...world.facts.flatMap((fact) => fact.citations),
    ...world.relationships.flatMap((relationship) => relationship.citations),
    ...world.timeline.flatMap((event) => event.citations),
    ...world.trackedStates.flatMap((state) => state.sourceExcerptIds),
  ];
  if (allReferences.some((id) => !available.has(id))) throw new Error('世界资料引用了未纳入本世界索引的原文片段。');
  for (const suggestion of world.startSuggestions) if (suggestion.chapterNumber > novel.chapters.length) throw new Error('推荐起点章节不存在。');
  return world;
}

export function validateWorldSnapshot(value: unknown): WorldModel {
  const world = WorldModelSchema.parse(value) as WorldModel;
  if (world.availableExcerptIds.some((id) => world.availableExcerptChapters[id] === undefined) || Object.keys(world.availableExcerptChapters).some((id) => !world.availableExcerptIds.includes(id))) {
    throw new Error('世界资料的阅读范围索引无效。');
  }
  if (Object.values(world.availableExcerptChapters).some((chapter) => chapter > world.chapterCount)) throw new Error('世界资料的阅读章节超出原著范围。');
  return world;
}
