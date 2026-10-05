export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  transport?: 'direct' | 'local-proxy';
}

export interface JsonRequest {
  system: string;
  user: string;
  signal?: AbortSignal;
  retry?: JsonRequestRetryOptions;
  onProgress?: (event: JsonRequestProgressEvent) => void;
}

export type ModelErrorCode = 'configuration' | 'authentication' | 'rate-limit' | 'server' | 'http' | 'network' | 'timeout' | 'cancelled' | 'malformed-response';

export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly code: ModelErrorCode,
    readonly retryable = ['rate-limit', 'server', 'network', 'timeout'].includes(code),
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

export interface JsonRequestRetryOptions {
  /** Number of retries after the first attempt. Defaults to zero to avoid unexpected duplicate charges. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export type JsonRequestProgressEvent =
  | { type: 'attempt-start'; attempt: number; maxAttempts: number }
  | { type: 'attempt-failed'; attempt: number; maxAttempts: number; code: ModelErrorCode; retryable: boolean }
  | { type: 'retry-scheduled'; attempt: number; maxAttempts: number; delayMs: number; code: ModelErrorCode };

export function normalizeChatUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new ModelRequestError('请填写有效的模型服务地址。', 'configuration');
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHosts.has(parsed.hostname))) {
    throw new ModelRequestError('模型服务必须使用 HTTPS；本机 localhost 测试地址除外。', 'configuration');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ModelRequestError('服务地址不能包含账号、密码、查询参数或片段。', 'configuration');
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return `${parsed.origin}${path}`;
  if (!path.endsWith('/v1')) path = `${path}/v1`;
  return `${parsed.origin}${path}/chat/completions`;
}

function getMessageContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new ModelRequestError('模型返回内容无法识别。', 'malformed-response');
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    throw new ModelRequestError('模型没有返回可用结果。', 'malformed-response');
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') throw new ModelRequestError('模型没有返回消息内容。', 'malformed-response');
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const joined = content.flatMap((item) => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? [(item as { text: string }).text] : []).join('\n');
    if (joined) return joined;
  }
  throw new ModelRequestError('模型没有返回文本结果。', 'malformed-response');
}

function parseJsonContent<T>(content: string): T {
  const withoutFence = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end < start) throw new ModelRequestError('模型结果不是有效的 JSON。请重试或更换模型。', 'malformed-response');
  try {
    return JSON.parse(withoutFence.slice(start, end + 1)) as T;
  } catch {
    throw new ModelRequestError('模型返回的 JSON 不完整。请重试或更换模型。', 'malformed-response');
  }
}

function cancelledError(): ModelRequestError {
  return new ModelRequestError('请求已取消。', 'cancelled', false);
}

function reportProgress(request: JsonRequest, event: JsonRequestProgressEvent) {
  try { request.onProgress?.(event); } catch { /* Progress observers must not interrupt the model request. */ }
}

function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => { finish(); reject(cancelledError()); };
    const timer = setTimeout(() => { finish(); resolve(); }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

export async function requestJson<T>(config: ModelConfig, request: JsonRequest): Promise<T> {
  const directUrl = normalizeChatUrl(config.baseUrl);
  const useLocalProxy = config.transport === 'local-proxy';
  const url = useLocalProxy ? '/__local_model_proxy' : directUrl;
  if (!config.apiKey.trim() || !config.model.trim()) throw new ModelRequestError('请填写 API 密钥和模型名称。', 'configuration');
  const maxRetries = boundedInteger(request.retry?.maxRetries, 0, 5);
  const maxAttempts = maxRetries + 1;
  const baseDelayMs = boundedInteger(request.retry?.baseDelayMs, 1_000, 60_000);
  const maxDelayMs = boundedInteger(request.retry?.maxDelayMs, 15_000, 60_000);
  const timeoutMs = boundedInteger(request.retry?.timeoutMs, 180_000, 600_000) || 180_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (request.signal?.aborted) throw cancelledError();
    reportProgress(request, { type: 'attempt-start', attempt, maxAttempts });
    try {
      const controller = new AbortController();
      let timedOut = false;
      const forwardAbort = () => controller.abort();
      request.signal?.addEventListener('abort', forwardAbort, { once: true });
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: useLocalProxy
            ? { 'Content-Type': 'application/json', 'X-Model-Endpoint': directUrl, 'X-Model-Api-Key': config.apiKey, 'X-Model-Name': config.model }
            : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.45,
            messages: [
              { role: 'system', content: `${request.system}\n\nReturn exactly one valid JSON object, without markdown fences.` },
              { role: 'user', content: request.user },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) throw new ModelRequestError('模型服务拒绝了密钥，请检查服务地址和 API 密钥。', 'authentication', false);
          if (response.status === 429) throw new ModelRequestError('模型服务暂时限流，请稍后重试。', 'rate-limit', true, retryAfterMilliseconds(response));
          if (response.status === 408 || response.status === 504) throw new ModelRequestError('模型服务处理超时，请重试。', 'timeout', true);
          if (response.status >= 500) {
            throw new ModelRequestError('模型服务暂时不可用，请稍后重试。', 'server', true);
          }
          throw new ModelRequestError(`模型服务返回错误（${response.status}），请检查模型名称和接口地址。`, 'http', false);
        }
        let payload: unknown;
        try { payload = await response.json(); }
        catch (error) {
          if (error instanceof SyntaxError) throw new ModelRequestError('模型响应不是有效的 JSON。请重试或更换模型。', 'malformed-response', false);
          throw error;
        }
        return parseJsonContent<T>(getMessageContent(payload));
      } catch (error) {
        if (error instanceof ModelRequestError) throw error;
        if (request.signal?.aborted) throw cancelledError();
        if (timedOut || controller.signal.aborted) throw new ModelRequestError('模型请求等待超时。请重试。', 'timeout', true);
        throw new ModelRequestError('无法连接模型服务。请检查网络、地址和浏览器跨域设置。', 'network', true);
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', forwardAbort);
      }
    } catch (error) {
      const modelError = error instanceof ModelRequestError ? error : new ModelRequestError('模型请求失败。', 'network', true);
      reportProgress(request, { type: 'attempt-failed', attempt, maxAttempts, code: modelError.code, retryable: modelError.retryable });
      if (!modelError.retryable || attempt >= maxAttempts) throw modelError;
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const delayMs = Math.max(backoffMs, Math.min(60_000, modelError.retryAfterMs ?? 0));
      reportProgress(request, { type: 'retry-scheduled', attempt, maxAttempts, delayMs, code: modelError.code });
      await waitBeforeRetry(delayMs, request.signal);
    }
  }
  throw new ModelRequestError('模型请求失败。', 'network', true);
}

export async function verifyConnection(config: ModelConfig): Promise<true> {
  const result = await requestJson<{ connected?: unknown }>(config, {
    system: 'Connection check. Return JSON only.',
    user: 'Return {"connected":true}.',
  });
  if (!result || result.connected !== true) throw new ModelRequestError('服务未确认连接成功。请检查模型名称、接口兼容性和响应格式。', 'malformed-response');
  return true;
}
