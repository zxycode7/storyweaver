import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeChatUrl, requestJson, verifyConnection, type ModelConfig } from '../../src/ai/client';

const config: ModelConfig = { baseUrl: 'https://api.example.test/v1/', apiKey: 'private-key-123', model: 'demo-model' };

afterEach(() => vi.unstubAllGlobals());

describe('model client', () => {
  it('normalizes common base URL forms without duplicating the endpoint', () => {
    expect(normalizeChatUrl('https://api.example.test')).toBe('https://api.example.test/v1/chat/completions');
    expect(normalizeChatUrl('https://api.example.test/v1/')).toBe('https://api.example.test/v1/chat/completions');
    expect(normalizeChatUrl('https://api.example.test/v1/chat/completions')).toBe('https://api.example.test/v1/chat/completions');
    expect(() => normalizeChatUrl('http://remote.example.test/v1')).toThrow(/HTTPS/i);
  });

  it('sends the secret only as a bearer header and parses JSON chat content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestJson<{ ok: boolean }>(config, { system: 'system', user: 'user' })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/chat/completions');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer private-key-123');
    expect(String(init.body)).toContain('demo-model');
  });

  it('uses only the same-origin local proxy when that transport is selected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestJson<{ ok: boolean }>({ ...config, transport: 'local-proxy' }, { system: 'system', user: 'user' })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe('/__local_model_proxy');
    expect(headers.get('X-Model-Endpoint')).toBe('https://api.example.test/v1/chat/completions');
    expect(headers.get('X-Model-Api-Key')).toBe('private-key-123');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('does not send omitted future chapter facts to the model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"connected":true}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await verifyConnection(config);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports endpoint failures without leaking the API key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'denied' } }), { status: 401 })));
    await expect(requestJson(config, { system: 'system', user: 'user' })).rejects.toThrow(/API 密钥/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`failed with private-key-123`)));
    await expect(requestJson(config, { system: 'system', user: 'user' })).rejects.not.toThrow('private-key-123');
  });

  it('requires the connection check to return an explicit success value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"connected":false}' } }] }), { status: 200 })));
    await expect(verifyConnection(config)).rejects.toThrow(/未确认连接成功/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"connected":true}' } }] }), { status: 200 })));
    await expect(verifyConnection(config)).resolves.toBe(true);
  });

  it('retries transient server failures with bounded attempts and reports progress', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const events: string[] = [];

    await expect(requestJson<{ ok: boolean }>(config, {
      system: 'system', user: 'user', retry: { maxRetries: 1, baseDelayMs: 0 },
      onProgress: (event) => events.push(`${event.type}:${event.attempt}`),
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['attempt-start:1', 'attempt-failed:1', 'retry-scheduled:1', 'attempt-start:2']);
  });

  it('waits for the upstream Retry-After interval when recovering from rate limiting', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '5' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let retryDelay = 0;
    const result = requestJson<{ ok: boolean }>(config, {
      system: 'system', user: 'user', retry: { maxRetries: 1, baseDelayMs: 100 },
      onProgress: (event) => { if (event.type === 'retry-scheduled') retryDelay = event.delayMs; },
    });

    await vi.waitFor(() => expect(retryDelay).toBe(5_000));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not retry authentication or other non-transient HTTP failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestJson(config, { system: 'system', user: 'user', retry: { maxRetries: 3, baseDelayMs: 0 } }))
      .rejects.toMatchObject({ code: 'authentication' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('treats an explicit upstream request timeout as retryable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 408 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestJson<{ ok: boolean }>(config, { system: 'system', user: 'user', retry: { maxRetries: 1, baseDelayMs: 0 } }))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries truncated Grok JSON responses and requests structured JSON output', async () => {
    const grokConfig = { ...config, model: 'grok-4-0709' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"ok":' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const failures: Array<{ code: string; retryable: boolean; diagnostics?: { finishReason?: string; responseChars?: number } }> = [];

    await expect(requestJson<{ ok: boolean }>(grokConfig, {
      system: 'system', user: 'user', retry: { maxRetries: 1, baseDelayMs: 0 },
      onProgress: (event) => { if (event.type === 'attempt-failed') failures.push(event); },
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const firstBody = JSON.parse(String(firstInit.body)) as { response_format?: unknown; max_tokens?: number };
    expect(firstBody.response_format).toEqual({ type: 'json_object' });
    expect(firstBody.max_tokens).toBeGreaterThanOrEqual(16_384);
    expect(failures.map(({ code, diagnostics, retryable }) => ({ code, diagnostics, retryable }))).toEqual([{ code: 'malformed-response', diagnostics: { finishReason: 'length', responseChars: 6 }, retryable: true }]);
  });

  it('distinguishes its own timeout from a user cancellation', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const timedOut = requestJson(config, { system: 'system', user: 'user', retry: { timeoutMs: 10 } });
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await timeoutAssertion;

    const controller = new AbortController();
    const cancelled = requestJson(config, { system: 'system', user: 'user', signal: controller.signal, retry: { timeoutMs: 100 } });
    const cancellationAssertion = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await cancellationAssertion;
    vi.useRealTimers();
  });

  it('stops retry backoff immediately when the caller aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockRejectedValue(new Error('temporary network failure'));
    vi.stubGlobal('fetch', fetchMock);
    let scheduled!: () => void;
    const result = requestJson(config, {
      system: 'system', user: 'user', signal: controller.signal,
      retry: { maxRetries: 2, baseDelayMs: 10_000 },
      onProgress: (event) => { if (event.type === 'retry-scheduled') scheduled = () => controller.abort(); },
    });
    await vi.waitFor(() => expect(scheduled).toBeTypeOf('function'));
    scheduled();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not leak transport exceptions through the public error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-key-123 novel chapter text')));
    await expect(requestJson(config, { system: 'secret story', user: 'private novel text' }))
      .rejects.toThrow('无法连接模型服务');
    await expect(requestJson(config, { system: 'secret story', user: 'private novel text' }))
      .rejects.not.toThrow(/private-key-123|novel chapter text|private novel text/);
  });
});
