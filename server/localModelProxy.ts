import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect } from 'vite';
import { isLoopbackPage, validateLocalProxyTarget } from '../src/ai/localProxy';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function reply(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('模型请求超过本机代理的 256 KiB 上限。');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function localModelProxy(): Connect.NextHandleFunction {
  return async (request, response, next) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/__local_model_proxy') return next();
    if (request.method !== 'POST') return reply(response, 405, '本机模型代理只允许 POST。');

    let target: string;
    try {
      target = validateLocalProxyTarget(request.headers.origin, request.headers.host, String(request.headers['x-model-endpoint'] ?? ''));
    } catch (error) {
      return reply(response, 403, error instanceof Error ? error.message : '本机模型转发请求无效。');
    }

    let parsedOrigin: URL;
    try { parsedOrigin = new URL(String(request.headers.origin)); }
    catch { return reply(response, 403, '请求来源无效。'); }
    if (!isLoopbackPage(parsedOrigin.origin)) return reply(response, 403, '本机模型代理仅可从本机网页使用。');

    const apiKey = String(request.headers['x-model-api-key'] ?? '');
    const model = String(request.headers['x-model-name'] ?? '');
    if (!apiKey || !model) return reply(response, 400, '请填写模型密钥和模型名称。');
    let body: string;
    try { body = await readBody(request); }
    catch (error) { return reply(response, 413, error instanceof Error ? error.message : '模型请求过大。'); }

    const abortController = new AbortController();
    request.on('aborted', () => abortController.abort());
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abortController.abort(); }, 210_000);
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
        signal: abortController.signal,
        redirect: 'error',
      });
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      response.writeHead(upstream.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      if (!upstream.body) { response.end(); return; }
      const reader = upstream.body.getReader();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          abortController.abort();
          if (!response.headersSent) reply(response, 502, '模型响应超过 2 MiB 上限。');
          else response.destroy(new Error('Model response too large'));
          return;
        }
        if (!response.write(value)) await new Promise<void>((resolve) => response.once('drain', resolve));
      }
      response.end();
    } catch {
      if (!response.headersSent) reply(response, timedOut ? 504 : 502, timedOut ? '模型服务处理超时，请重试。' : '无法连接模型服务，请检查网络和服务状态。');
      else {
        abortController.abort();
        response.destroy(new Error('Upstream model response ended unexpectedly'));
      }
    } finally {
      clearTimeout(timeout);
    }
  };
}
