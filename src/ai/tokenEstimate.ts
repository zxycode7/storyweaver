export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
export const CONTEXT_WINDOW_OPTIONS = [
  { label: '32k', value: 32_000 },
  { label: '64k', value: 64_000 },
  { label: '128k', value: 128_000 },
  { label: '256k', value: 256_000 },
  { label: '512k', value: 512_000 },
  { label: '1M', value: 1_000_000 },
] as const;

const MAX_INPUT_TOKENS = 256_000;

export function estimateModelTokens(text: string): number {
  let estimate = 0;
  let latinRun = 0;
  const flushLatin = () => {
    if (!latinRun) return;
    estimate += latinRun / 3.5;
    latinRun = 0;
  };

  for (const character of text) {
    if (/[A-Za-z0-9]/.test(character)) {
      latinRun += 1;
      continue;
    }
    flushLatin();
    if (/\s/u.test(character)) continue;
    estimate += /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(character)
      ? 1
      : character.codePointAt(0)! <= 0x7f ? 0.35 : 1;
  }
  flushLatin();
  return Math.ceil(estimate * 1.15);
}

export function getWorldBatchTokenBudget(contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS): number {
  const context = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
    ? contextWindowTokens
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.min(MAX_INPUT_TOKENS, Math.floor(context * 0.75));
}
