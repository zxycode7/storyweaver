import { z } from 'zod';
import type { WorldModel } from './world';

export type Difficulty = 'relaxed' | 'balanced' | 'high-stakes';
export type DynamicValue = string | number;

export interface StoryPlayer {
  kind: 'character' | 'original';
  characterId?: string;
  name: string;
  description?: string;
}

export interface StorySetup {
  title: string;
  startChapter: number;
  difficulty: Difficulty;
  player: StoryPlayer;
  guidance?: string;
}

export interface StoryTurn {
  id: string;
  action: string;
  narration: string;
  chapter: number;
  worldTime: string;
  changes: Array<{ key: string; before: DynamicValue; after: DynamicValue; reason: string }>;
  relevantCharacterIds: string[];
  changeSummary: string[];
  citations: string[];
  priorState: Record<string, DynamicValue>;
  priorChapter: number;
  priorWorldTime: string;
  createdAt: string;
}

export interface StoryArchive {
  schemaVersion: 1;
  id: string;
  worldId: string;
  novelId: string;
  title: string;
  player: StoryPlayer;
  startChapter: number;
  chapter: number;
  difficulty: Difficulty;
  worldTime: string;
  state: Record<string, DynamicValue>;
  guidance?: string;
  turns: StoryTurn[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TurnProposal {
  baseVersion: number;
  narration: string;
  chapter: number;
  worldTime: string;
  changes: Array<{ key: string; value: DynamicValue; reason: string }>;
  relevantCharacterIds: string[];
  changeSummary: string[];
  citations: string[];
}

const TurnProposalSchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  narration: z.string().min(1).max(8_000),
  chapter: z.number().int().positive(),
  worldTime: z.string().min(1).max(120),
  changes: z.array(z.object({ key: z.string().min(1), value: z.union([z.string().max(300), z.number()]), reason: z.string().min(1).max(240) }).strict()).max(20),
  relevantCharacterIds: z.array(z.string().min(1)).max(20),
  changeSummary: z.array(z.string().min(1).max(240)).max(8),
  citations: z.array(z.string().min(1)).max(12),
}).strict();

const StoryPlayerSchema = z.object({ kind: z.enum(['character', 'original']), characterId: z.string().optional(), name: z.string().min(1).max(100), description: z.string().max(500).optional() }).strict();
const StoryTurnSchema = z.object({
  id: z.string().min(1), action: z.string().max(2_000), narration: z.string().min(1).max(8_000), chapter: z.number().int().positive(), worldTime: z.string().max(120),
  changes: z.array(z.object({ key: z.string(), before: z.union([z.string(), z.number()]), after: z.union([z.string(), z.number()]), reason: z.string().max(240) }).strict()),
  relevantCharacterIds: z.array(z.string()), changeSummary: z.array(z.string().max(240)), citations: z.array(z.string()), priorState: z.record(z.union([z.string(), z.number()])),
  priorChapter: z.number().int().positive(), priorWorldTime: z.string().max(120), createdAt: z.string(),
}).strict();
const StoryArchiveSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), worldId: z.string().min(1), novelId: z.string().min(1), title: z.string().min(1).max(200),
  player: StoryPlayerSchema, startChapter: z.number().int().positive(), chapter: z.number().int().positive(),
  difficulty: z.enum(['relaxed', 'balanced', 'high-stakes']), worldTime: z.string().max(120), state: z.record(z.union([z.string(), z.number()])),
  guidance: z.string().max(1_000).optional(),
  turns: z.array(StoryTurnSchema).max(20_000), version: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
}).strict();

export function validateStoryArchive(value: unknown): StoryArchive {
  let normalized = value;
  if (value && typeof value === 'object' && 'spoilerCeiling' in value) {
    const { spoilerCeiling: _legacyReadBoundary, ...current } = value as Record<string, unknown>;
    normalized = current;
  }
  const archive = StoryArchiveSchema.parse(normalized) as StoryArchive;
  if (archive.chapter < archive.startChapter) throw new Error('故事档案的章节范围无效。');
  if (archive.version !== archive.turns.length) throw new Error('故事档案的版本记录不完整。');
  return archive;
}

export function validateStoryAgainstWorld(value: unknown, world: WorldModel): StoryArchive {
  const archive = validateStoryArchive(value);
  if (archive.worldId !== world.id || archive.novelId !== world.novelId) throw new Error('故事档案与世界资料不匹配。');
  if (archive.chapter > world.chapterCount) throw new Error('故事档案超出原著章节范围。');
  const allowed = new Set(world.availableExcerptIds);
  for (const turn of archive.turns) {
    for (const citation of turn.citations) {
      const sourceChapter = world.availableExcerptChapters[citation];
      if (!allowed.has(citation) || sourceChapter === undefined) throw new Error('故事档案引用了未开放的原文片段。');
      if (sourceChapter > turn.chapter) throw new Error('故事档案中的原文引用超出当前故事进度。');
    }
  }
  return archive;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `story-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneState(state: Record<string, DynamicValue>): Record<string, DynamicValue> {
  return { ...state };
}

export function createStoryArchive(world: WorldModel, setup: StorySetup, now = new Date().toISOString()): StoryArchive {
  if (!Number.isInteger(setup.startChapter) || setup.startChapter < 1 || setup.startChapter > world.chapterCount) {
    throw new Error('故事起点超出小说章节。');
  }
  if (setup.player.kind === 'character') {
    const character = world.characters.find((item) => item.id === setup.player.characterId);
    if (!character) throw new Error('所选原著角色不存在。');
    if (character.firstChapter > setup.startChapter) throw new Error('所选角色在当前故事起点尚未登场。');
    setup = { ...setup, player: { ...setup.player, name: character.name } };
  } else if (!setup.player.name.trim()) {
    throw new Error('原创角色需要一个名字。');
  }
  const state = Object.fromEntries(world.trackedStates
    .filter((definition) => definition.introducedChapter <= setup.startChapter)
    .map((definition) => [definition.id, definition.initialValue]));
  return {
    schemaVersion: 1, id: makeId(), worldId: world.id, novelId: world.novelId,
    title: setup.title.trim() || `${setup.player.name} 的故事`, player: setup.player,
    startChapter: setup.startChapter, chapter: setup.startChapter,
    difficulty: setup.difficulty, worldTime: `第 ${setup.startChapter} 章`, state, guidance: setup.guidance?.trim().slice(0, 1_000) || undefined, turns: [], version: 0,
    createdAt: now, updatedAt: now,
  };
}

export function applyTurnProposal(archive: StoryArchive, rawProposal: TurnProposal, world: WorldModel, action = ''): StoryArchive {
  const proposal = TurnProposalSchema.parse(rawProposal);
  if (proposal.baseVersion !== archive.version) throw new Error('故事版本已变化，请重新获取结果后再保存。');
  if (proposal.chapter < archive.chapter || proposal.chapter > world.chapterCount) throw new Error('回合推进超出当前故事范围。');
  const definitions = new Map(world.trackedStates.map((definition) => [definition.id, definition]));
  const seen = new Set<string>();
  const nextState = cloneState(archive.state);
  for (const definition of world.trackedStates) {
    if (definition.introducedChapter <= archive.chapter && !(definition.id in nextState)) nextState[definition.id] = definition.initialValue;
  }
  const changes: StoryTurn['changes'] = [];
  for (const change of proposal.changes) {
    const definition = definitions.get(change.key);
    if (!definition || !(change.key in nextState)) throw new Error(`模型尝试修改了未定义或尚未出现的状态：${change.key}`);
    if (seen.has(change.key)) throw new Error(`模型重复修改了状态：${change.key}`);
    seen.add(change.key);
    if (typeof definition.initialValue !== typeof change.value) throw new Error(`状态 ${change.key} 的类型无效。`);
    if (typeof change.value === 'number') {
      if (definition.min !== undefined && change.value < definition.min) throw new Error(`状态 ${change.key} 低于允许范围。`);
      if (definition.max !== undefined && change.value > definition.max) throw new Error(`状态 ${change.key} 高于允许范围。`);
    }
    changes.push({ key: change.key, before: nextState[change.key], after: change.value, reason: change.reason });
    nextState[change.key] = change.value;
  }
  const knownCharacterIds = new Set(world.characters.map((character) => character.id));
  if (proposal.relevantCharacterIds.some((id) => !knownCharacterIds.has(id))) throw new Error('回合引用了世界中不存在的人物。');
  const knownExcerptIds = new Set([
    ...world.availableExcerptIds,
    ...world.characters.flatMap((character) => character.sourceExcerptIds),
    ...world.facts.flatMap((fact) => fact.citations),
    ...world.relationships.flatMap((relationship) => relationship.citations),
    ...world.timeline.flatMap((event) => event.citations),
    ...world.trackedStates.flatMap((state) => state.sourceExcerptIds),
  ]);
  if (proposal.citations.some((id) => !knownExcerptIds.has(id))) throw new Error('回合引用了世界资料中不存在的原文片段。');

  const turn: StoryTurn = {
    id: makeId(), action, narration: proposal.narration, chapter: proposal.chapter,
    worldTime: proposal.worldTime, changes, relevantCharacterIds: proposal.relevantCharacterIds,
    changeSummary: proposal.changeSummary, citations: proposal.citations, priorState: cloneState(archive.state),
    priorChapter: archive.chapter, priorWorldTime: archive.worldTime, createdAt: new Date().toISOString(),
  };
  return {
    ...archive, chapter: proposal.chapter, worldTime: proposal.worldTime, state: nextState,
    turns: [...archive.turns, turn], version: archive.version + 1, updatedAt: turn.createdAt,
  };
}

export function undoLastTurn(archive: StoryArchive): StoryArchive {
  const last = archive.turns[archive.turns.length - 1];
  if (!last) return archive;
  return {
    ...archive, chapter: last.priorChapter, worldTime: last.priorWorldTime,
    state: cloneState(last.priorState), turns: archive.turns.slice(0, -1),
    version: Math.max(0, archive.version - 1), updatedAt: new Date().toISOString(),
  };
}
