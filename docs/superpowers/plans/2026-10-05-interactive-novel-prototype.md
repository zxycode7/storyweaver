# Interactive Novel Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable browser prototype that imports a novel, builds a source-grounded world through the user's model endpoint, lets them choose a role and play freeform turns, and saves the ongoing story locally.

**Architecture:** A responsive React/TypeScript PWA separates novel parsing and story rules from model transport, IndexedDB persistence, and UI. The browser sends only selected excerpts and player input directly to a user-configured OpenAI-compatible endpoint; validated model proposals become incremental story events and state updates. TXT and Markdown are the first supported import formats so the end-to-end play loop can be verified before broadening file support.

**Tech Stack:** Vite, React, TypeScript, Vitest, React Testing Library, `fake-indexeddb`, and Zod for validating model proposals.

**Spec:** `docs/superpowers/specs/2026-10-05-ai-novel-interactive-story-design.md`

## Global Constraints

- “先读懂原著，再组织玩法”: users do not select a fixed genre template; the AI derives an appropriate play model from the imported book.
- Players may choose a source character or original character, and can freely describe actions.
- Canon facts and player-created story facts remain separate; extracted facts preserve chapter references.
- Characters relevant to the current scene act consistently with their own goals; mechanics and tracked state are book-specific.
- Story state persists locally and can be exported/imported; API credentials never enter a story archive.
- Novel content and player input go only to the selected model endpoint; the app must disclose that transmission before world generation.
- Keep the first playable slice narrow: `.txt` and `.md` imports up to 25 MiB, no OCR, no generated art, no accounts, no sync, no arbitrary model-generated code.
- Show model request count before disclosure/consent; request count grows with selected text length, and never label it as a cost estimate without current provider pricing.
- The workspace currently has no Git repository; implement in the existing project directory and do not initialize Git or create commits as part of this plan.

---

## File Structure

- `src/domain/novel.ts`: decode bounded plain text and Markdown, split chapters, and retain stable chapter and excerpt IDs.
- `src/domain/world.ts`: types and validation for extracted facts, characters, chronology, and the book-specific play model.
- `src/domain/story.ts`: story archive types, role setup, turn-event application, and undo semantics.
- `src/ai/client.ts`: direct OpenAI-compatible chat-completions transport with cancellation and safe error messages.
- `src/ai/prompts.ts`: world extraction, synthesis, and action-resolution prompts with source-ID contracts.
- `src/ai/worldBuilder.ts`: chunked world extraction and validation against supplied source excerpt IDs.
- `src/ai/turnEngine.ts`: retrieve relevant source material and request a structured, incremental turn proposal.
- `src/storage/storyRepository.ts`: IndexedDB schema and CRUD/import/export helpers; archive serializers exclude secrets and original novel contents.
- `src/App.tsx`: high-level setup, play, and archive navigation.
- `src/components/*`: focused views for provider setup, import/progress, world summary, role/start selection, story play, and state/change inspection.
- `src/styles.css`: responsive visual system and layout.
- `tests/domain/*`, `tests/ai/*`, `tests/storage/*`, `tests/app/*`: behavior-focused unit and integration coverage.

## Task 1: Bootstrap the web application and test harness

**Files:**
- Create: `package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/test/setup.ts`
- Test: `tests/app/smoke.test.tsx`

**Interfaces:**
- Produces a Vite development app mounted from `src/main.tsx` and a Vitest + jsdom test command.
- Keep scripts named `dev`, `build`, `test`, and `typecheck`.

- [ ] Create a Vite React TypeScript shell and configure Vitest with jsdom and React Testing Library.
- [ ] Add `smoke.test.tsx` that renders `App` and asserts the initial product name and novel-import entry point are visible.
- [ ] Run `npm test -- --run tests/app/smoke.test.tsx`; confirm it fails before adding the matching shell, then pass it.
- [ ] Run `npm run typecheck` and `npm run build`.

## Task 2: Implement novel parsing and source-grounded story domain

**Files:**
- Create: `src/domain/novel.ts`, `src/domain/world.ts`, `src/domain/story.ts`
- Test: `tests/domain/novel.test.ts`, `tests/domain/world.test.ts`, `tests/domain/story.test.ts`

**Interfaces:**
- `parseNovelText(input: string, filename: string): ParsedNovel` returns `{ id, title, chapters: Array<{ id, number, title, text, startOffset, endOffset }> }`.
- Reject files above 25 MiB with a clear message. Chapter boundaries recognize common English headings (`Chapter 1`, `Chapter One`) and Chinese headings (`第十二章`, optional title); when no headings exist, split at paragraph boundaries near 4,000 characters and keep deterministic IDs/offsets for the same input.
- Each chapter is divided into bounded excerpts with stable IDs. `WorldModel` contains a premise, tone/style notes, source-grounded facts, characters, relationships, canon timeline, compact tracked-state definitions, narrative drivers, the set of available excerpt IDs, and a chapter number for each available ID. Every canon fact cites one or more excerpt IDs supplied in its request; render the local excerpt when a user opens a citation instead of trusting a model-generated quote. Speculative deductions carry `confidence` and `kind: "inference"`.
- `StoryArchive` stores selected player role, starting chapter, difficulty (`relaxed | balanced | high-stakes`), dynamic state, turn events, and timestamps; it never contains provider credentials or full source text.
- `validateStoryAgainstWorld(story, world)` rejects story citations beyond the current turn chapter. Exports bundle validated story and world metadata/index, but never original novel text or provider credentials; import still requires the matching local novel file.
- `applyTurnProposal(archive, proposal)` accepts only a version-checked incremental proposal, appends a turn event, and returns a new archive. `undoLastTurn(archive)` restores the exact prior state from event snapshots.

- [ ] Write parser tests for Chinese/English chapter detection, no-heading fallback, title fallback, stable source/excerpt IDs, accepting 10 MiB novels, and rejection above 25 MiB; run them and verify the missing export fails.
- [ ] Implement `parseNovelText` and run `npm test -- --run tests/domain/novel.test.ts`.
- [ ] Write world validation tests rejecting references to unknown excerpt IDs and empty character IDs, while preserving low-confidence inferences as distinct from canon.
- [ ] Implement the world types/validator and run `npm test -- --run tests/domain/world.test.ts`.
- [ ] Write story reducer tests for a valid incremental change and undo, plus rejection of stale versions and state fields that were not defined by the world model.
- [ ] Implement story archive/reducer functions and run `npm test -- --run tests/domain/story.test.ts`.

## Task 3: Add model transport and novel-to-world generation

**Files:**
- Create: `src/ai/client.ts`, `src/ai/prompts.ts`, `src/ai/worldBuilder.ts`, `src/ai/turnEngine.ts`
- Test: `tests/ai/client.test.ts`, `tests/ai/worldBuilder.test.ts`, `tests/ai/turnEngine.test.ts`

**Interfaces:**
- `ModelConfig` is `{ baseUrl: string, apiKey: string, model: string }`; normalize a base URL with or without a trailing `/v1` to the chat-completions route without logging the key.
- `requestJson<T>(config, { system, user, signal? }): Promise<T>` calls a tested OpenAI-compatible endpoint directly from the browser, requests a JSON object, parses fenced or plain JSON, and throws typed errors for authentication, rate limit, CORS/network, cancellation, and malformed response. Validate endpoint connectivity before sending novel passages; do not promise broad compatibility.
- `buildWorld(novel, config, onProgress, signal?): Promise<WorldModel>` extracts at most 3 adjacent chapters per request, includes stable excerpt IDs in prompts, then synthesizes a validated world model; progress reports completed extraction batches and estimated calls before generation.
- `resolveTurn(world, archive, playerAction, config, signal?): Promise<TurnProposal>` includes only relevant excerpts/facts at or below the current story chapter and within the character's knowledge, plus current state; it asks for narration and incremental changes and validates all IDs/fields against the world model before returning.
- Model-generated novel text is untrusted content, never executable instructions; prompts explicitly delimit it as reference material.

- [ ] Write client tests for URL normalization, authorization header, JSON parsing, response status classification, timeout/abort, and ensuring errors never include the API key; run tests to verify `requestJson` is missing.
- [ ] Implement `requestJson` using injected/global `fetch` so tests can provide a deterministic local stub, then run `npm test -- --run tests/ai/client.test.ts`.
- [ ] Write world-builder tests that use a fake model response to verify chapter batching, progress callbacks, and validation against supplied excerpt IDs; confirm malformed citations reject the result.
- [ ] Implement extraction/synthesis prompts and `buildWorld`, then run its tests.
- [ ] Write turn-engine tests for source filtering by current story chapter, current character knowledge, relevant state retrieval, and rejection of undefined state changes. Do not include a future-facing full-book summary in player prompts.
- [ ] Implement `resolveTurn`, then run `npm test -- --run tests/ai/turnEngine.test.ts`.

## Task 4: Persist and export local story archives

**Files:**
- Create: `src/storage/storyRepository.ts`, `src/storage/archiveFormat.ts`
- Test: `tests/storage/storyRepository.test.ts`, `tests/storage/archiveFormat.test.ts`

**Interfaces:**
- `StoryRepository` exposes `saveWorld(world)`, `listWorlds()`, `saveStory(archive)`, `getStory(id)`, `listStories()`, and `deleteStory(id)` using IndexedDB transactions.
- `exportArchive(archive, world): Blob` serializes the story and validated world index, not API configuration or original chapter text.
- `importArchive(file): Promise<{ story: StoryArchive, world: WorldModel }>` validates a versioned archive and its story/world citation boundary before returning it; unknown schema versions fail with a user-readable error.
- Tests use `fake-indexeddb` and reset the database between cases.

- [ ] Write repository CRUD tests and archive secret/source exclusion tests, confirm imports/exports are missing, and observe the failure.
- [ ] Implement IndexedDB repository and versioned archive format; run `npm test -- --run tests/storage`.
- [ ] Add a migration-safe database version and verify repository tests still pass after reopening the database.

## Task 5: Build the full first-play experience

**Files:**
- Create: `src/components/ProviderSetup.tsx`, `src/components/NovelImport.tsx`, `src/components/WorldReview.tsx`, `src/components/StorySetup.tsx`, `src/components/StoryPlay.tsx`, `src/components/StoryInspector.tsx`
- Modify: `src/App.tsx`, `src/styles.css`
- Test: `tests/app/first-play-flow.test.tsx`

**Interfaces:**
- App steps are `connect → import → build-world → review → setup-story → play`; user can resume any saved story from the home view.
- Provider config remains React/session memory only and is never passed into repository/export functions.
- Import accepts `.txt` and `.md` files up to 25 MiB, displays detected chapters, and lets the user adjust chapter splits before building.
- Build the world from all chapters. Player-facing summaries are spoiler-safe, story setup asks for a story start rather than reader progress, and each turn retrieves only source facts up to its current chapter.
- World review shows a short spoiler-safe premise, tone, narrative drivers, source-linked visible characters, and uncertain inferences; users can accept immediately or add a plain-language correction.
- Story setup supports up to eight source-character choices or a lightweight original character, a start chapter within the imported novel, and relaxed/balanced/high-stakes difficulty; balanced is default. The import screen does not ask how far the reader has read.
- Story play provides a freeform action input, request/loading state, narration, optional contextual action suggestions, recent changes, compact book-specific state, undo, and archive export. Only characters directly relevant to the current scene advance; defer full-world background simulation and the dual-track timeline visualization.
- Before the first novel excerpt is sent, show an explicit inline disclosure naming the configured endpoint and stating that novel passages/player actions are sent to that model provider; require a clear “Continue and analyze” action.

- [ ] Write an integration test with a real TXT fixture and a deterministic fake provider covering import, world setup, character selection, one freeform turn, persistence, resume, and undo; run and verify it fails because the flow is absent.
- [ ] Build the import/provider setup and first-run disclosure; run the flow test to its expected next failure.
- [ ] Add AI world progress/review and story setup; run the flow test to its expected next failure.
- [ ] Add playable story loop, persistence, resume, and undo; make the full first-play test pass.
- [ ] Add responsive visual polish for a readable narrative column, restrained world dossier side panel, and mobile stacked layout without putting technical caveats in the play screen.
- [ ] Run the full suite, `npm run typecheck`, and `npm run build`; manually launch the app and verify the first screen renders at desktop and mobile widths.

## Task 6: Verify the prototype against product constraints

**Files:**
- Test: all files under `tests/`
- Modify as needed: any implementation files above

- [ ] Verify story export contains no provider key or full novel text by inspecting a generated archive in tests.
- [ ] Verify future-chapter facts, character choices, and source excerpts are unavailable to the player/model request when the story chapter is earlier than their source chapter.
- [ ] Verify imported/exported turns cannot cite excerpts outside the story's current chapter and the included world excerpt index.
- [ ] Verify a rejected or interrupted model response does not mutate a saved story.
- [ ] Run `npm test -- --run`, `npm run typecheck`, and `npm run build` after all fixes.
- [ ] Report remaining limitations explicitly (tested endpoint compatibility, file types, model cost/quality, and absence of multi-device sync).
