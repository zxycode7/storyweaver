import { useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, FileText, Upload, X } from 'lucide-react';
import { MAX_NOVEL_BYTES, MAX_NOVEL_SIZE_LABEL, parseNovelText, type ParsedNovel } from '../domain/novel';
import { decodeNovelBytes } from '../domain/encoding';

interface NovelImportProps {
  onBack: () => void;
  onContinue: (novel: ParsedNovel) => void;
}

function readFileBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('文件没有以二进制方式读取。'));
    reader.onerror = () => reject(reader.error ?? new Error('无法读取这个文件。'));
    reader.readAsArrayBuffer(file);
  });
}

export default function NovelImport({ onBack, onContinue }: NovelImportProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [novel, setNovel] = useState<ParsedNovel>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    setReading(true);
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('首版支持 .txt 和 .md 文件。');
      if (file.size > MAX_NOVEL_BYTES) throw new Error(`文件超过 ${MAX_NOVEL_SIZE_LABEL} 上限，请先拆分小说再导入。`);
      const parsed = parseNovelText(await decodeNovelBytes(await readFileBytes(file)), file.name);
      if (!parsed.chapters.some((chapter) => chapter.excerpts.some((excerpt) => excerpt.text.trim()))) throw new Error('没有找到正文内容，请检查文件。');
      setNovel(parsed);
    } catch (cause) {
      setNovel(undefined);
      setError(cause instanceof Error ? cause.message : '文件解析失败。');
    } finally {
      setReading(false);
      event.target.value = '';
    }
  };

  const excerpt = novel?.chapters[0]?.excerpts[0]?.text ?? '';

  return (
    <main className="setup-shell import-shell">
      <button className="back-link" onClick={onBack} type="button"><ArrowLeft size={16} /> 返回模型设置</button>
      <div className="setup-card import-card">
        <div className="step-kicker"><span className="step-index">02</span> BRING A NOVEL</div>
        <div className="setup-icon"><BookOpen size={21} /></div>
        <h1>带一本小说来</h1>
        <p className="setup-intro">整本小说会用于理解世界、人物与叙事规律。开始故事时再选择起点；游玩中 AI 只会引用当前故事进度内的原文。</p>
        <input ref={fileRef} hidden aria-label="导入小说文件" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={handleFile} />
        {!novel ? (
          <button type="button" className="dropzone" onClick={() => fileRef.current?.click()} disabled={reading}>
            <span className="upload-orb">{reading ? <span className="spinner" /> : <Upload size={22} />}</span>
            <strong>{reading ? '正在本机读取…' : '选择一本小说'}</strong>
            <span>支持 TXT / Markdown · 不超过 {MAX_NOVEL_SIZE_LABEL}</span>
            <span className="dropzone-foot">自动识别 UTF-8 / GB18030 / Big5 等常见编码</span>
          </button>
        ) : (
          <section className="novel-preview">
            <div className="novel-file-row">
              <div className="file-icon"><FileText size={20} /></div>
              <div className="novel-file-copy"><strong>{novel.title}</strong><span>{novel.chapters.length} 个章节 · {novel.charCount.toLocaleString()} 字符 · {novel.filename}</span></div>
              <button type="button" className="icon-button" aria-label="移除小说" onClick={() => setNovel(undefined)}><X size={17} /></button>
            </div>
            <div className="chapter-preview"><span>第一章 · {novel.chapters[0]?.title}</span><p>{excerpt.slice(0, 260)}{excerpt.length > 260 ? '…' : ''}</p></div>
            <div className="local-check"><Check size={15} /> 章节与文字编码在本机识别 · 建世界时整本小说会分批发送给你选择的模型</div>
          </section>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
        {novel && <button type="button" className="primary-button full-button" onClick={() => onContinue(novel)}>继续 <ArrowRight size={17} /></button>}
        <div className="supported-note"><span className="tiny-dot" /> 当前支持大篇幅 TXT / Markdown；PDF、EPUB 与扫描件暂未支持</div>
      </div>
    </main>
  );
}
