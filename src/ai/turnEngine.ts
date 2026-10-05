import type { ModelConfig } from './client';
import { requestJson } from './client';
import { buildTurnPrompt, turnSystemPrompt, type SourceExcerptContext } from './prompts';
import type { ParsedNovel } from '../domain/novel';
import { applyTurnProposal, type StoryArchive, type TurnProposal } from '../domain/story';
import type { WorldModel } from '../domain/world';

const MAX_TURN_SOURCES = 8;

export interface TurnContext {
  sources: SourceExcerptContext[];
  prompt: string;
}

export function buildTurnContext(novel: ParsedNovel, world: WorldModel, archive: StoryArchive, action: string): TurnContext {
  const maxCanonChapter = archive.chapter;
  const characterById = new Map(world.characters.map((character) => [character.id, character]));
  const namedCharacters = world.characters.filter((character) => character.firstChapter <= archive.chapter && action.includes(character.name));
  const targetExcerptIds = new Set<string>();
  if (archive.player.kind === 'character' && archive.player.characterId) {
    const playerCharacter = characterById.get(archive.player.characterId);
    if (playerCharacter && playerCharacter.summaryChapter <= maxCanonChapter) playerCharacter.sourceExcerptIds.forEach((id) => targetExcerptIds.add(id));
  }
  namedCharacters.forEach((character) => character.sourceExcerptIds.forEach((id) => targetExcerptIds.add(id)));
  for (const fact of world.facts) {
    if (fact.chapterNumber > maxCanonChapter) continue;
    if (namedCharacters.some((character) => fact.citations.some((id) => character.sourceExcerptIds.includes(id)))) fact.citations.forEach((id) => targetExcerptIds.add(id));
  }
  const ranked: Array<{ source: SourceExcerptContext; score: number }> = [];
  for (const chapter of novel.chapters) {
    if (chapter.number > maxCanonChapter) continue;
    for (const excerpt of chapter.excerpts) {
      let score = chapter.number * 2;
      if (chapter.number === maxCanonChapter) score += 50;
      if (targetExcerptIds.has(excerpt.id)) score += 80;
      ranked.push({ source: { id: excerpt.id, chapterNumber: chapter.number, chapterTitle: chapter.title, text: excerpt.text }, score });
    }
  }
  const sources = ranked.sort((a, b) => b.score - a.score || b.source.chapterNumber - a.source.chapterNumber)
    .slice(0, MAX_TURN_SOURCES).map(({ source }) => source);
  return { sources, prompt: buildTurnPrompt(novel, world, archive, action, sources) };
}

export async function resolveTurn(novel: ParsedNovel, world: WorldModel, archive: StoryArchive, action: string, config: ModelConfig, signal?: AbortSignal): Promise<TurnProposal> {
  if (!action.trim()) throw new Error('先写下你想做的事。');
  const context = buildTurnContext(novel, world, archive, action);
  const proposal = await requestJson<TurnProposal>(config, {
    system: turnSystemPrompt(),
    user: context.prompt,
    signal,
  });
  const allowedCitations = new Set(context.sources.map((source) => source.id));
  if (proposal.citations.some((id) => !allowedCitations.has(id))) throw new Error('模型引用了本回合未提供的原文片段。');
  applyTurnProposal(archive, proposal, world, action);
  return proposal;
}
