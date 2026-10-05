const PRIVATE_IPV4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function validateLocalProxyTarget(origin: string | undefined, host: string | undefined, rawTarget: string): string {
  if (!origin || !host) throw new Error('本机模型转发只允许由本机网页发起。');
  const parsedOrigin = new URL(origin);
  const originHost = parsedOrigin.host.toLowerCase();
  const requestHost = host.toLowerCase();
  const localOrigin = parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1' || parsedOrigin.hostname === '::1';
  if (!localOrigin || originHost !== requestHost) throw new Error('本机模型转发只接受同源请求。');

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new Error('请填写有效的 HTTPS 模型接口地址。');
  }
  const path = target.pathname.replace(/\/+$/, '');
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || !path.endsWith('/v1/chat/completions')) {
    throw new Error('请填写有效模型端点，地址必须是 HTTPS 且路径以 /v1/chat/completions 结尾。');
  }
  const currentOrigin = parsedOrigin.host.toLowerCase();
  if (target.host.toLowerCase() === currentOrigin || target.hostname === 'localhost' || PRIVATE_IPV4.test(target.hostname) || target.hostname === '::1') {
    throw new Error('模型服务端点不能指向当前网页或本机网络。');
  }
  return target.toString();
}

export function isLoopbackPage(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}
