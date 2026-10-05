import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, BookOpenCheck, Check, ChevronRight, CircleHelp, Clock3, FileUp, Plus, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import ProviderSetup from './components/ProviderSetup';
import NovelImport from './components/NovelImport';
import StoryPlay from './components/StoryPlay';
import StorySetup from './components/StorySetup';
import WorldReview from './components/WorldReview';
import { buildWorld, createWorldBatches, type WorldBuildProgress } from './ai/worldBuilder';
import { ModelRequestError, type ModelConfig } from './ai/client';
import { MAX_NOVEL_BYTES, MAX_NOVEL_SIZE_LABEL, parseNovelText, type ParsedNovel } from './domain/novel';
import { createStoryArchive, type StoryArchive, type StorySetup as StorySetupData } from './domain/story';
import type { WorldModel } from './domain/world';
import { StoryRepository } from './storage/storyRepository';
import { importArchive, type ImportedStoryBundle } from './storage/archiveFormat';
import { validateWorldModel } from './domain/world';
import { decodeNovelBytes } from './domain/encoding';

type View = 'home' | 'provider' | 'import' | 'consent' | 'building' | 'review' | 'story-setup' | 'play';
interface LibraryItem { archive: StoryArchive; novelTitle: string }
interface PendingBuildItem { novelId: string; novelTitle: string; filename: string; completedBatches: number; totalBatches: number; updatedAt: string }
const repository = new StoryRepository();

export default function App() {
  const [view, setView] = useState<View>('home');
  const [config, setConfig] = useState<ModelConfig>();
  const [pendingStoryId, setPendingStoryId] = useState<string>();
  const [pendingBuildNovelId, setPendingBuildNovelId] = useState<string>();
  const [novel, setNovel] = useState<ParsedNovel>();
  const [world, setWorld] = useState<WorldModel>();
  const [archive, setArchive] = useState<StoryArchive>();
  const [guidance, setGuidance] = useState('');
  const [progress, setProgress] = useState<WorldBuildProgress>();
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [pendingBuilds, setPendingBuilds] = useState<PendingBuildItem[]>([]);
  const [libraryError, setLibraryError] = useState('');
  const [flowError, setFlowError] = useState('');
  const [pendingBundle, setPendingBundle] = useState<ImportedStoryBundle>();
  const buildAbort = useRef<AbortController>();
  const [clockNow, setClockNow] = useState(Date.now());

  useEffect(() => {
    if (view !== 'building') return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [view]);

  const refreshLibrary = useCallback(async () => {
    try {
      const stories = await repository.listStories();
      const items = await Promise.all(stories.map(async (item) => ({ archive: item, novelTitle: (await repository.getNovel(item.novelId))?.title ?? '已导入的小说' })));
      const checkpoints = await repository.listWorldBuildCheckpoints();
      const builds = await Promise.all(checkpoints.map(async (checkpoint) => {
        const savedNovel = await repository.getNovel(checkpoint.novelId);
        if (!savedNovel) return undefined;
        return { novelId: savedNovel.id, novelTitle: savedNovel.title, filename: savedNovel.filename, completedBatches: Object.keys(checkpoint.digests ?? {}).length, totalBatches: createWorldBatches(savedNovel).length, updatedAt: checkpoint.updatedAt };
      }));
      setLibrary(items);
      setPendingBuilds(builds.filter((build): build is PendingBuildItem => Boolean(build)));
      setLibraryError('');
    } catch {
      setLibraryError('无法读取本机故事档案。请检查浏览器本机存储空间。');
    }
  }, []);

  useEffect(() => { void refreshLibrary(); }, [refreshLibrary]);

  const begin = () => {
    setPendingStoryId(undefined); setFlowError(''); setNovel(undefined); setWorld(undefined); setArchive(undefined); setGuidance(''); setView('provider');
  };

  const openSavedStory = async (id: string, activeConfig?: ModelConfig) => {
    const saved = await repository.getStory(id);
    if (!saved) throw new Error('找不到这条故事线。');
    const [savedNovel, savedWorld] = await Promise.all([repository.getNovel(saved.novelId), repository.getWorld(saved.worldId)]);
    if (!savedNovel || !savedWorld) throw new Error('缺少这条故事线的本机小说资料。请重新导入小说。');
    setNovel(savedNovel); setWorld(savedWorld); setArchive(saved);
    if (!activeConfig) { setPendingStoryId(id); setView('provider'); return; }
    setView('play');
  };

  const handleConnected = async (nextConfig: ModelConfig) => {
    setConfig(nextConfig);
    if (pendingStoryId) {
      try { await openSavedStory(pendingStoryId, nextConfig); setPendingStoryId(undefined); }
      catch (cause) { setFlowError(cause instanceof Error ? cause.message : '无法打开这条故事线。'); setView('home'); }
    } else if (pendingBuildNovelId) {
      try {
        const savedNovel = await repository.getNovel(pendingBuildNovelId);
        if (!savedNovel) throw new Error('找不到待继续整理的小说，请重新导入。');
        setNovel(savedNovel); setPendingBuildNovelId(undefined); setFlowError(''); setProgress(undefined); setView('consent');
      } catch (cause) { setFlowError(cause instanceof Error ? cause.message : '无法恢复这本小说。'); setView('home'); }
    } else setView('import');
  };

  const resumeBuild = async (novelId: string) => {
    try {
      const savedNovel = await repository.getNovel(novelId);
      if (!savedNovel) throw new Error('找不到待继续整理的小说，请重新导入。');
      setNovel(savedNovel); setPendingBuildNovelId(novelId); setFlowError(''); setView('provider');
    } catch (cause) { setFlowError(cause instanceof Error ? cause.message : '无法恢复这本小说。'); }
  };

  const requestEstimate = useMemo(() => novel ? createWorldBatches(novel).length + 1 : 0, [novel]);

  const analyzeNovel = async () => {
    if (!novel || !config) { setFlowError('请先导入小说并连接模型服务。'); return; }
    setFlowError(''); setProgress(undefined); setView('building');
    const controller = new AbortController(); buildAbort.current = controller;
    try {
      await repository.saveNovel(novel);
      const nextWorld = await buildWorld(novel, config, setProgress, controller.signal, repository);
      await repository.completeWorldBuild(nextWorld, `world-build-${novel.id}`);
      setWorld(nextWorld); setView('review');
    } catch (cause) {
      setFlowError(cause instanceof ModelRequestError && cause.code === 'cancelled' ? '已停止整理。已完成的批次已保留，之后可以继续。' : cause instanceof Error ? cause.message : '世界准备失败。');
      setProgress((current) => current?.status === 'complete' ? { ...current, status: 'failed', errorCode: 'local-storage', failedBatch: { number: current.total, chapterLabel: '保存到本机', errorCode: 'local-storage' } } : current);
      setView('consent');
    }
    finally { buildAbort.current = undefined; }
  };

  const startStory = async (setup: StorySetupData) => {
    if (!world) throw new Error('还没有完成世界准备。');
    const created = createStoryArchive(world, { ...setup, guidance });
    await repository.saveStory(created); setArchive(created); await refreshLibrary(); setView('play');
  };

  const finishRestore = async (bundle: ImportedStoryBundle, sourceNovel: ParsedNovel) => {
    if (sourceNovel.id !== bundle.story.novelId) throw new Error('这本小说与故事档案不匹配。请选择导出故事时使用的同一份原文。');
    const checkedWorld = validateWorldModel(bundle.world, sourceNovel);
    const existing = await repository.getStory(bundle.story.id);
    const restoredStory = existing ? { ...bundle.story, id: `restored-${Date.now().toString(36)}` } : bundle.story;
    await repository.saveNovel(sourceNovel);
    await repository.saveWorld(checkedWorld);
    await repository.saveStory(restoredStory);
    setPendingBundle(undefined);
    await refreshLibrary();
  };

  const handleImportArchive = async (file: File) => {
    setFlowError('');
    try {
      const bundle = await importArchive(file);
      const localNovel = await repository.getNovel(bundle.story.novelId);
      if (localNovel) await finishRestore(bundle, localNovel);
      else setPendingBundle(bundle);
    } catch (cause) {
      setFlowError(cause instanceof Error ? cause.message : '无法恢复故事档案。');
    }
  };

  const handleRestoreNovel = async (file: File) => {
    if (!pendingBundle) return;
    try {
      if (!/\.(txt|md)$/i.test(file.name) || file.size > MAX_NOVEL_BYTES) throw new Error(`请选择 ${MAX_NOVEL_SIZE_LABEL} 以内的 TXT 或 Markdown 原文。`);
      const source = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('文件没有以二进制方式读取。'));
        reader.onerror = () => reject(reader.error ?? new Error('原文读取失败。'));
        reader.readAsArrayBuffer(file);
      });
      const parsed = parseNovelText(await decodeNovelBytes(source), file.name);
      await finishRestore(pendingBundle, parsed);
    } catch (cause) {
      setFlowError(cause instanceof Error ? cause.message : '无法恢复故事档案。');
    }
  };

  if (view === 'provider') return <>
    {flowError && <div className="global-notice" role="alert">{flowError}</div>}
    <ProviderSetup onBack={() => { setPendingStoryId(undefined); setPendingBuildNovelId(undefined); setView('home'); }} onConnected={handleConnected} />
  </>;
  if (view === 'import') return <NovelImport onBack={() => setView('provider')} onContinue={(parsed) => { setNovel(parsed); setFlowError(''); setView('consent'); }} />;
  if (view === 'consent' && novel && config) {
    const savedBatchCount = progress ? Math.min(progress.completed, Math.max(0, progress.total - 1)) : 0;
    return <main className="setup-shell">
      <button className="back-link" onClick={() => setView('import')} type="button"><ChevronRight className="flip-icon" size={16} /> 返回阅读范围</button>
      <section className="setup-card consent-card">
        <div className="step-kicker"><span className="step-index">05</span> BEFORE WE BEGIN</div>
        <div className="setup-icon"><ShieldCheck size={21} /></div>
        <h1>这本书会去哪里？</h1>
        <p className="setup-intro">在建世界之前，先看清楚会发生什么。</p>
        <div className="consent-route"><span className="route-node local-node"><BookOpen size={18} /></span><span className="route-line" /><span className="route-node model-node"><Sparkles size={18} /></span><div className="route-labels"><span><strong>你的浏览器</strong><small>整本原文先在本机解析；所有章节留在本机存档。</small></span><span><strong>你选择的模型服务</strong><small>{config.baseUrl} · {config.model}</small></span></div></div>
        <div className="consent-scope"><div className="scope-icon"><BookOpenCheck size={17} /></div><div><strong>整本小说用于建立世界资料</strong><p>《{novel.title}》共 {novel.chapters.length} 章，会分批发送给你选择的模型服务。游玩时只会检索当前故事起点和进度内的内容；结局和后续事件不会在开局时提前带入。</p></div></div>
        <div className="consent-details"><div><span>预计模型请求</span><strong>约 {requestEstimate} 次起</strong></div><p>小说越长，请求和费用通常越多；每批与全书汇总最多自动重试 2 次，极端情况下最多再增加约 {requestEstimate * 2} 次请求。若超时后服务商已处理但响应未送达，重试可能产生重复费用。实际费用由服务商单价决定。</p></div>
        {flowError && <div className="inline-error" role="alert">{flowError}</div>}
        {progress?.failedBatch && <div className="build-resume-note" role="status"><strong>已保留 {savedBatchCount} / {Math.max(0, requestEstimate - 1)} 份整理结果</strong><span>上次停在{progress.failedBatch.chapterLabel}（第 {progress.failedBatch.number} 批，诊断码：{progress.failedBatch.errorCode}）。再次继续会跳过已完成的内容。</span></div>}
        <button className="primary-button full-button" type="button" onClick={analyzeNovel}>{savedBatchCount > 0 ? `从已保存的 ${savedBatchCount} 份继续` : '同意发送整本小说并建世界'} <ArrowRight size={17} /></button>
        <p className="consent-footnote">不继续也不会发送小说内容。Storyweaver 不接收你的原文或 API 密钥。</p>
      </section>
    </main>;
  }
  if (view === 'building' && novel) {
    const percent = progress ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
    const batchCount = progress ? Math.max(0, progress.total - 1) : requestEstimate - 1;
    const elapsedSeconds = Math.max(0, Math.floor((clockNow - (progress?.startedAt ?? clockNow)) / 1_000));
    const elapsed = `${Math.floor(elapsedSeconds / 60)} 分 ${String(elapsedSeconds % 60).padStart(2, '0')} 秒`;
    const activeBatches = progress?.activeBatches ?? [];
    const statusText = progress?.status === 'retrying' ? `${progress.stage === 'synthesizing' ? '全书汇总' : '当前批次'}暂时失败，正在等待后自动重试${progress.errorCode ? `（诊断码：${progress.errorCode}）` : ''}…`
      : progress?.stage === 'synthesizing' ? '正在合并全书资料，生成可玩的世界模型…'
        : progress?.status === 'validating' ? '模型已返回，正在校验结构和原文引用…'
          : progress?.status === 'saving' ? '资料已校验，正在保存本机检查点…'
            : activeBatches.length > 0 ? '正在等待模型服务处理当前批次…'
              : '准备安排下一批章节…';
    return <main className="setup-shell building-shell"><div className="setup-card build-card">
      <div className="build-orbit"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span><BookOpenCheck size={27} /></span></div>
      <div className="step-kicker">A NEW WORLD IS TAKING SHAPE</div>
      <h1>{progress?.stage === 'synthesizing' ? '正在读出故事的脉络' : '正在读这本书'}</h1>
      <p className="setup-intro">系统正按章节批次整理人物、关系与事件，并核对原文出处。成功的批次会保存到本机，失败后可以从未完成处继续。</p>
      <div className="build-progress-label"><span>已完成 {Math.min(progress?.completed ?? 0, batchCount)} / {batchCount} 份章节整理{progress?.resumed ? ` · 恢复 ${progress.resumed} 份` : ''}</span><strong>{percent}%</strong></div>
      <div className="progress-track" role="progressbar" aria-label="世界整理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
      <div className="build-status-line" role="status" aria-live="polite"><span className={progress?.status === 'retrying' ? 'status-dot status-warn' : 'status-dot'} />{statusText}</div>
      <div className="build-active-list">{activeBatches.map((batch) => <div className="build-active-row" key={batch.number}><strong>第 {batch.number} 批 · {batch.chapterLabel}</strong><span>{batch.status === 'retrying' ? `第 ${batch.attempt} 次失败（${batch.errorCode}），${Math.ceil((batch.retryDelayMs ?? 0) / 1_000)} 秒后重试` : batch.status === 'validating' ? '核对返回内容与引用' : batch.status === 'saving' ? '写入本机检查点' : `正在等待模型响应${batch.attempt ? ` · 尝试 ${batch.attempt}/${batch.maxAttempts}` : ''}`}</span></div>)}</div>
      <div className="build-diagnostics"><span>运行时长 <strong>{elapsed}</strong></span><span>章节 <strong>{novel.chapters.length}</strong></span><span>同时处理 <strong>最多 2 批</strong></span></div>
      <button className="quiet-button" type="button" onClick={() => buildAbort.current?.abort()}>停止并保留已完成部分</button>
    </div></main>;
  }
  if (view === 'review' && novel && world) return <WorldReview novel={novel} world={world} onBack={() => setView('consent')} onContinue={(nextGuidance) => { setGuidance(nextGuidance); setView('story-setup'); }} />;
  if (view === 'story-setup' && world) return <StorySetup world={world} guidance={guidance} onBack={() => setView('review')} onStart={startStory} />;
  if (view === 'play' && novel && world && archive && config) return <StoryPlay novel={novel} world={world} archive={archive} config={config} repository={repository} onArchiveChange={(next) => { setArchive(next); void refreshLibrary(); }} onHome={() => { void refreshLibrary(); setView('home'); }} />;

  return <>
  <Home library={library} pendingBuilds={pendingBuilds} error={libraryError} flowError={flowError} onStart={begin} onResumeBuild={(id) => { void resumeBuild(id); }} onImportArchive={(file) => { void handleImportArchive(file); }} onContinue={(id) => {
    setFlowError('');
    if (config) void openSavedStory(id, config).catch((cause) => setFlowError(cause instanceof Error ? cause.message : '无法打开这条故事线。'));
    else { setPendingStoryId(id); setView('provider'); }
  }} />
  {pendingBundle && <RestoreNovelDialog bundle={pendingBundle} error={flowError} onCancel={() => { setPendingBundle(undefined); setFlowError(''); }} onChoose={handleRestoreNovel} />}
  </>;
}

interface HomeProps { library: LibraryItem[]; pendingBuilds: PendingBuildItem[]; error: string; flowError: string; onStart: () => void; onResumeBuild: (novelId: string) => void; onImportArchive: (file: File) => void; onContinue: (id: string) => void }

function Home({ library, pendingBuilds, error, flowError, onStart, onResumeBuild, onImportArchive, onContinue }: HomeProps) {
  const importRef = useRef<HTMLInputElement>(null);
  return <main className="home-shell">
    <header className="home-nav"><a className="brand-lockup" href="#home" aria-label="Storyweaver 首页"><span className="brand-mark"><BookOpen size={18} /></span><span>storyweaver</span></a><div className="nav-right"><span className="local-pill"><span className="tiny-dot" /> 本机优先</span><button type="button" className="nav-help" aria-label="关于 Storyweaver" title="小说和存档保存在你的浏览器；模型费用由模型服务商收取。"><CircleHelp size={18} /></button></div></header>
    {(error || flowError) && <div className="home-error" role="alert">{error || flowError}</div>}
    <section className="home-hero">
      <div className="hero-copy">
        <div className="hero-kicker"><span /> YOUR BOOK. ANOTHER LIFE.</div>
        <h1>让小说成为<br /><em>你可以进入的世界</em></h1>
        <p className="hero-subtitle">带来一本小说和你熟悉的 AI。<br />AI 读懂这本书，再由你的选择写出新的故事。</p>
        <div className="hero-actions"><button type="button" className="primary-button hero-button" onClick={onStart}><span className="button-mark"><Plus size={16} /></span> 开始一个新故事 <ArrowRight size={17} /></button><button type="button" className="restore-button" onClick={() => importRef.current?.click()}><FileUp size={15} /> 导入故事档案</button><input ref={importRef} hidden type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImportArchive(file); event.target.value = ''; }} /></div>
        <div className="hero-trust"><ShieldCheck size={15} /><span>小说在本机解析 · 模型由你选择 · 故事保存在这台设备</span></div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div className="art-glow" /><div className="floating-note note-top"><span>世界会记住</span><strong>你来过</strong></div>
        <div className="book-stack"><div className="book-shadow" /><div className="book-cover"><span className="cover-topline">STORYWEAVER&nbsp; / &nbsp;VOL. 01</span><div className="cover-illustration"><div className="window-shape"><span /><i /><b /></div><div className="plant plant-left"><i /><i /><i /></div><div className="table-shape" /></div><div className="cover-title">雨停以后<br /><small>AFTER THE RAIN</small></div><div className="cover-author">一个尚未写下的故事</div></div><div className="paper-edge" /></div>
        <div className="floating-note note-bottom"><span className="mini-avatar">林</span><div><small>某个未写下的瞬间</small><strong>她把灯留着。</strong></div></div>
        <span className="sparkle sparkle-a">✳</span><span className="sparkle sparkle-b">✳</span><span className="art-caption">01 — A STORY THAT REMEMBERS</span>
      </div>
    </section>
    {pendingBuilds.length > 0 && <section className="library-section pending-build-section"><div className="section-title"><div><span className="eyebrow">PICK UP YOUR WORLD BUILD</span><h2>继续准备中的世界</h2></div></div><div className="library-grid">{pendingBuilds.map((build) => <button className="library-card pending-build-card" type="button" key={build.novelId} onClick={() => onResumeBuild(build.novelId)}><span className="library-cover"><BookOpenCheck size={19} /></span><span className="library-copy"><strong>继续整理《{build.novelTitle}》</strong><small>{build.filename}</small><em><Clock3 size={12} /> {build.completedBatches} 份已保存 · 共 {build.totalBatches} 份</em></span><ChevronRight size={17} /></button>)}</div></section>}
    {library.length > 0 && <section className="library-section"><div className="section-title"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>你的故事</h2></div><button type="button" className="small-create-button" onClick={onStart}><Plus size={15} /> 新故事</button></div><div className="library-grid">{library.map(({ archive: saved, novelTitle }) => <button className="library-card" type="button" key={saved.id} onClick={() => onContinue(saved.id)}><span className="library-cover"><BookOpen size={19} /></span><span className="library-copy"><strong>{saved.title}</strong><small>{novelTitle} · {saved.player.name}</small><em><Clock3 size={12} /> {saved.worldTime} · {saved.turns.length} 个片段</em></span><ChevronRight size={17} /></button>)}</div></section>}
    <section className="promise-strip"><div><span className="promise-icon"><BookOpenCheck size={16} /></span><span><strong>不是统一模板</strong><small>AI 为这本书读出适合它的玩法</small></span></div><div><span className="promise-icon"><Sparkles size={16} /></span><span><strong>选择会留下痕迹</strong><small>人物和故事线持续记住你做过的事</small></span></div><div><span className="promise-icon"><ShieldCheck size={16} /></span><span><strong>你的小说，你的模型</strong><small>原文与密钥不经过 Storyweaver 服务器</small></span></div></section>
    <footer className="home-footer"><span>STORYWEAVER <i>·</i> 一个仍在生长的故事工具</span><span><Upload size={13} /> TXT / MD&nbsp; <i>·</i>&nbsp; {MAX_NOVEL_SIZE_LABEL} 上限&nbsp; <i>·</i>&nbsp; IndexedDB 本机存档&nbsp; <i>·</i>&nbsp; {library.length > 0 && <><Check size={12} /> {library.length} 条本机故事</>}</span></footer>
  </main>;
}

function RestoreNovelDialog({ bundle, error, onCancel, onChoose }: { bundle: ImportedStoryBundle; error: string; onCancel: () => void; onChoose: (file: File) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return <div className="modal-scrim"><section className="restore-modal" role="dialog" aria-modal="true" aria-labelledby="restore-title">
    <div className="setup-icon"><BookOpen size={20} /></div><h2 id="restore-title">再选一次这本小说</h2>
    <p>故事档案里保存了人物与故事状态，没有复制小说正文。请选择导出时使用的同一份 TXT 或 Markdown 文件；文字编码会自动识别，并在本机验证匹配后保存。</p>
    <div className="restore-meta"><strong>{bundle.story.title}</strong><span>原文标识 · {bundle.story.novelId}</span></div>
    <input ref={fileRef} hidden type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) onChoose(file); event.target.value = ''; }} />
    {error && <div className="inline-error" role="alert">{error}</div>}
    <button type="button" className="primary-button full-button" onClick={() => fileRef.current?.click()}>选择本机原文 <Upload size={16} /></button>
    <button type="button" className="quiet-button" onClick={onCancel}>取消恢复</button>
  </section></div>;
}
