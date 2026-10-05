import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles, Wifi } from 'lucide-react';
import { verifyConnection, type ModelConfig } from '../ai/client';
import { isLoopbackPage } from '../ai/localProxy';

interface ProviderSetupProps {
  onBack: () => void;
  onConnected: (config: ModelConfig) => void;
}

const PROVIDERS = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '自定义接口', url: '', model: '' },
];

export default function ProviderSetup({ onBack, onConnected }: ProviderSetupProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [useLocalProxy, setUseLocalProxy] = useState(() => typeof window !== 'undefined' && isLoopbackPage(window.location.origin));
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  const pick = (provider: typeof PROVIDERS[number]) => {
    setBaseUrl(provider.url);
    setModel(provider.model);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const config = { baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim(), transport: useLocalProxy ? 'local-proxy' as const : 'direct' as const };
    setTesting(true);
    try {
      await verifyConnection(config);
      onConnected(config);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接模型服务失败。');
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="setup-shell">
      <button className="back-link" onClick={onBack} type="button"><ArrowLeft size={16} /> 返回</button>
      <div className="setup-card provider-card">
        <div className="step-kicker"><span className="step-index">01</span> CONNECT YOUR MODEL</div>
        <div className="setup-icon"><KeyRound size={21} /></div>
        <h1>先接入你的 AI</h1>
        <p className="setup-intro">用你自己的模型来读这本书、运行故事。密钥只在当前页面内存中使用，不会写进故事档案。</p>

        <div className="provider-pills" aria-label="选择模型服务">
          {PROVIDERS.map((provider) => <button type="button" key={provider.label} className="provider-pill" onClick={() => pick(provider)}>{provider.label}</button>)}
        </div>

        <form onSubmit={submit} className="form-stack">
          <label className="field-label">服务地址
            <input required autoComplete="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
          </label>
          <label className="field-label">模型名称
            <input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 gpt-4o-mini" />
          </label>
          <label className="field-label">API 密钥
            <span className="password-field">
              <input required autoComplete="off" type={reveal ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴你的 API key" />
              <button type="button" className="icon-button password-toggle" aria-label={reveal ? '隐藏密钥' : '显示密钥'} onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </span>
          </label>
          {typeof window !== 'undefined' && isLoopbackPage(window.location.origin) && <label className="transport-choice">
            <input type="checkbox" checked={useLocalProxy} onChange={(event) => setUseLocalProxy(event.target.checked)} />
            <span><strong>通过本机转发请求</strong><small>可避开模型服务未开放 CORS 的限制。密钥只由本机开发服务器临时转发，不写入文件；不要把开发服务器暴露到局域网。</small></span>
          </label>}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <button type="submit" className="primary-button full-button" disabled={testing}>
            {testing ? <><span className="spinner" /> 正在验证连接</> : <>测试连接并继续 <ArrowRight size={17} /></>}
          </button>
        </form>

        <div className="privacy-note"><ShieldCheck size={17} /><span>连接测试只发送一条短请求。小说文本会在下一步单独授权后发给这里填写的服务。</span></div>
        <div className="supported-note"><Wifi size={14} /> 仅承诺经测试的 OpenAI 兼容接口；跨域限制由服务商决定。</div>
      </div>
      <div className="setup-footer"><Sparkles size={14} /> YOUR MODEL. YOUR STORY.</div>
    </main>
  );
}
