import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, BookOpen, Check, Clock3, Download, RotateCcw, Send, ShieldAlert, Sparkles, Users } from 'lucide-react';
import { resolveTurn } from '../ai/turnEngine';
import type { ModelConfig } from '../ai/client';
import { findExcerpt, type ParsedNovel } from '../domain/novel';
import { applyTurnProposal, undoLastTurn, type StoryArchive } from '../domain/story';
import type { WorldModel } from '../domain/world';
import { exportArchive } from '../storage/archiveFormat';
import type { StoryRepository } from '../storage/storyRepository';

interface StoryPlayProps {
  novel: ParsedNovel;
  world: WorldModel;
  archive: StoryArchive;
  config: ModelConfig;
  repository: StoryRepository;
  onArchiveChange: (archive: StoryArchive) => void;
  onHome: () => void;
}

export default function StoryPlay({ novel, world, archive, config, repository, onArchiveChange, onHome }: StoryPlayProps) {
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveLabel, setSaveLabel] = useState('已保存到这台设备');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController>();
  const chapter = novel.chapters[archive.startChapter - 1];
  const visibleCharacters = useMemo(() => world.characters.filter((character) => character.firstChapter <= archive.chapter && character.summaryChapter <= archive.chapter).slice(0, 8), [world, archive.chapter]);
  const visibleStates = world.trackedStates.filter((state) => state.introducedChapter <= archive.chapter && state.id in archive.state);

  const playTurn = async (playerAction: string, isOpening = false) => {
    setBusy(true);
    setError('');
    setSaveLabel('正在保存…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const proposal = await resolveTurn(novel, world, archive, playerAction, config, controller.signal);
      let next = applyTurnProposal(archive, proposal, world, isOpening ? '' : playerAction);
      if (isOpening) {
        const lastTurn = next.turns[next.turns.length - 1];
        next = { ...next, turns: [...next.turns.slice(0, -1), { ...lastTurn, action: '' }] };
      }
      await repository.saveStory(next);
      onArchiveChange(next);
      setSaveLabel('已保存到这台设备');
      setAction('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '这次行动没有写入故事，请再试一次。');
      setSaveLabel('故事档案未改变');
    } finally {
      setBusy(false);
      abortRef.current = undefined;
      inputRef.current?.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!action.trim() || busy) return;
    await playTurn(action.trim());
  };

  const openStory = () => playTurn(`故事开场。请基于整本小说建立的世界索引、当前故事章节内的原文和角色设定，为玩家描写一个具体、符合这本书气质的入场场景。场景中给出一件值得回应的事，但不要替玩家作关键决定。`, true);

  const undo = async () => {
    if (!archive.turns.length || busy) return;
    const previous = undoLastTurn(archive);
    try {
      setSaveLabel('正在撤回…');
      await repository.saveStory(previous);
      onArchiveChange(previous);
      setSaveLabel('已保存到这台设备');
      setError('');
    } catch {
      setSaveLabel('撤回未保存');
      setError('无法保存撤回操作，当前故事没有改变。');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(exportArchive(archive, world));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${archive.title || 'story'}-storyweaver.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <main className="play-shell">
      <header className="play-topbar">
        <button className="play-brand" type="button" onClick={onHome}><span className="brand-mark mini-mark"><BookOpen size={15} /></span><span>storyweaver</span></button>
        <div className="play-top-meta"><span><Clock3 size={14} /> {archive.worldTime}</span><span className="saved-indicator"><span className="tiny-dot" /> {saveLabel}</span></div>
        <div className="play-top-actions"><button type="button" className="topbar-action" onClick={download}><Download size={15} /><span>导出故事</span></button><button type="button" className="topbar-action" onClick={onHome}><ArrowLeft size={15} /><span>我的故事</span></button></div>
      </header>
      <div className="play-layout">
        <section className="story-main-column">
          <div className="story-header">
            <div className="story-cover"><span className="cover-noise" /><BookOpen size={24} /><span>STORY<br />NO. 01</span></div>
            <div className="story-heading"><span className="eyebrow">A STORY INSPIRED BY</span><h1>{archive.title}</h1><p>{novel.title} <span>·</span> {archive.player.name} 的故事 <span>·</span> 当前第 {archive.chapter} 章</p></div>
            <button type="button" className="icon-button undo-button" disabled={!archive.turns.length || busy} onClick={undo} aria-label="撤回上一回合"><RotateCcw size={16} /></button>
          </div>
          <div className="story-scroll" aria-live="polite">
            {archive.turns.length === 0 && <div className="opening-card">
              <div className="opening-kicker"><Sparkles size={14} /> 故事从这里开始</div>
              <h2>{chapter?.title ?? '一个新的开始'}</h2>
              <p>{archive.player.kind === 'character' ? `你将从 ${archive.player.name} 的位置进入这个世界。` : `你将以 ${archive.player.name} 的身份走进这个世界。`}</p>
              <span className="opening-divider" />
              <p className="opening-note">你可以写下想做的事。人物会记得你，故事也会记得你的选择。</p>
              <button type="button" className="text-action" disabled={busy} onClick={openStory}>{busy ? <><span className="spinner" /> 正在写下开场</> : <>生成开场 <ArrowUpRight size={15} /></>}</button>
            </div>}
            {archive.turns.map((turn, index) => <article className="story-turn" key={turn.id}>
              <div className="turn-marker"><span>{String(index + 1).padStart(2, '0')}</span><i /></div>
              <div className="turn-content">
                {turn.action && <div className="player-action-line"><ArrowDownLeft size={13} /><span>{turn.action}</span></div>}
                <p className="narration">{turn.narration}</p>
                {turn.changeSummary.length > 0 && <div className="change-summary">{turn.changeSummary.map((change) => <span key={change}><span className="change-dot" /> {change}</span>)}</div>}
                {turn.citations.length > 0 && <details className="turn-sources"><summary>查看原著依据 <span>{turn.citations.length}</span></summary>{turn.citations.map((citation) => {
                  const source = findExcerpt(novel, citation);
                  if (!source) return null;
                  const sourceChapter = novel.chapters.find((item) => item.excerpts.some((excerpt) => excerpt.id === citation));
                  return <blockquote key={citation}><span>第 {sourceChapter?.number} 章 · {sourceChapter?.title}</span>{source.text}</blockquote>;
                })}</details>}
                <div className="turn-time">{turn.worldTime}</div>
              </div>
            </article>)}
            {busy && archive.turns.length > 0 && <div className="thinking-row"><span className="thinking-orb"><Sparkles size={14} /></span><span>故事正在回应你的行动…</span><button type="button" onClick={() => abortRef.current?.abort()}>取消</button></div>}
          </div>
          {error && <div className="play-error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div>}
          <form className="action-composer" onSubmit={submit}>
            <textarea ref={inputRef} rows={2} maxLength={2_000} value={action} onChange={(event) => setAction(event.target.value)} placeholder="写下你想做的事、说的话，或一个念头…" disabled={busy} />
            <div className="composer-foot"><span>故事会记住每个重要选择</span><button type="submit" className="send-button" aria-label="发送行动" disabled={busy || !action.trim()}><Send size={16} /></button></div>
          </form>
          <p className="model-cost-note">本回合内容会发送至你配置的模型服务 · 费用按模型服务商规则计算</p>
        </section>

        <aside className="story-inspector">
        <section className="inspector-card current-scene-card"><div className="inspector-heading"><span className="eyebrow">NOW IN THE STORY</span><span className="live-dot" /></div><h3>{archive.worldTime}</h3><p>从第 {archive.chapter} 章开始的故事进度</p><div className="scene-rule" /><div className="scene-label">原著世界</div><strong>共 {novel.chapters.length} 章</strong><small>AI 依据当前故事进度逐步引用原文</small></section>
          <section className="inspector-card"><div className="inspector-section-title"><Users size={15} /><h3>此刻的故事人物</h3></div><div className="cast-list">{visibleCharacters.slice(0, 5).map((character) => <div className="cast-item" key={character.id}><span className="cast-avatar">{character.name.slice(0, 1)}</span><span><strong>{character.name}</strong><small>{character.summary}</small></span></div>)}{visibleCharacters.length === 0 && <p className="empty-inspector">故事会从原创人物开始。</p>}</div></section>
          {visibleStates.length > 0 && <section className="inspector-card"><div className="inspector-section-title"><Sparkles size={15} /><h3>正在变化的事</h3></div><div className="state-list">{visibleStates.map((definition) => <div className="state-line" key={definition.id}><span><strong>{definition.label}</strong><small>{definition.description}</small></span><em>{archive.state[definition.id]}</em></div>)}</div></section>}
          <section className="inspector-card story-notes"><div className="inspector-section-title"><BookOpen size={15} /><h3>故事的底色</h3></div><p>{world.premise}</p><div className="note-tags">{world.narrativeDrivers.slice(0, 3).map((driver) => <span key={driver}>{driver}</span>)}</div></section>
          <div className="inspector-footer"><Check size={14} /> 每一步都保存在这台设备</div>
        </aside>
      </div>
    </main>
  );
}
