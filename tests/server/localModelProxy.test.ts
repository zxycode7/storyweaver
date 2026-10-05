import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { localModelProxy } from '../../server/localModelProxy';

function makeRequest() {
  const request = new EventEmitter() as IncomingMessage & AsyncIterable<Buffer>;
  Object.assign(request, {
    url: '/__local_model_proxy', method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173',
      'x-model-endpoint': 'https://api.example.test/v1/chat/completions',
      'x-model-api-key': 'private-key-123', 'x-model-name': 'test-model',
    },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"model":"test-model"}'); },
  });
  return request;
}

function makeResponse() {
  type MockResponse = EventEmitter & {
    headersSent: boolean; writableEnded?: boolean; statusCode?: number; chunks: Uint8Array[]; destroyedWith?: unknown;
    writeHead(statusCode: number): MockResponse; write(chunk: Uint8Array): boolean; end(): MockResponse; destroy(error?: Error): MockResponse;
  };
  const response = new EventEmitter() as MockResponse & ServerResponse;
  response.chunks = [];
  response.headersSent = false;
  response.writeHead = (statusCode) => { response.statusCode = statusCode; response.headersSent = true; return response; };
  response.write = (chunk) => { response.chunks.push(chunk); return true; };
  response.end = () => { response.writableEnded = true; return response; };
  response.destroy = (error) => { response.destroyedWith = error; return response; };
  return response;
}

describe('local model proxy transport failures', () => {
  it('destroys a response that fails after upstream headers instead of ending it as success', async () => {
    const reader = {
      read: vi.fn().mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"choices":') })
        .mockRejectedValueOnce(new Error('upstream socket reset')),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => reader },
    }));
    const response = makeResponse();

    await localModelProxy()(makeRequest(), response, vi.fn());

    expect(response.chunks).toHaveLength(1);
    expect(response.destroyedWith).toBeInstanceOf(Error);
    expect(response.writableEnded).not.toBe(true);
  });

  it('never includes credentials or request content in proxy errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-key-123 novel chapter text')));
    const response = makeResponse();
    await localModelProxy()(makeRequest(), response, vi.fn());
    const body = Buffer.concat(response.chunks).toString('utf8');
    expect(body).not.toMatch(/private-key-123|novel chapter text|test-model/);
  });
});
