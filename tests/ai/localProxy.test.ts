import { describe, expect, it } from 'vitest';
import { validateLocalProxyTarget } from '../../src/ai/localProxy';

describe('local model proxy guard', () => {
  it('allows a same-origin request to an HTTPS model completion endpoint', () => {
    expect(validateLocalProxyTarget('http://127.0.0.1:5173', '127.0.0.1:5173', 'https://code1.newcli.com/v1/chat/completions'))
      .toBe('https://code1.newcli.com/v1/chat/completions');
  });

  it('rejects cross-site callers and non-local insecure targets', () => {
    expect(() => validateLocalProxyTarget('https://evil.example', '127.0.0.1:5173', 'https://code1.newcli.com/v1/chat/completions')).toThrow(/同源/);
    expect(() => validateLocalProxyTarget('http://127.0.0.1:5173', '127.0.0.1:5173', 'http://code1.newcli.com/v1/chat/completions')).toThrow(/HTTPS/i);
  });

  it('rejects credentials, URL parameters, and non-completion routes', () => {
    expect(() => validateLocalProxyTarget('http://localhost:5173', 'localhost:5173', 'https://user:pass@code1.newcli.com/v1/chat/completions')).toThrow(/有效模型端点/);
    expect(() => validateLocalProxyTarget('http://localhost:5173', 'localhost:5173', 'https://code1.newcli.com/v1/models?key=x')).toThrow(/有效模型端点/);
  });
});
