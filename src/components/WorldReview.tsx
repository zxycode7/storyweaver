import { useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpenCheck, ChevronDown, Quote, Sparkles, Users } from 'lucide-react';
import { findExcerpt, type ParsedNovel } from '../domain/novel';
import type { WorldModel } from '../domain/world';

interface WorldReviewProps {
  novel: ParsedNovel;
  world: WorldModel;
  onBack: () => void;
  onContinue: (guidance: string) => void;
}

export default function WorldReview({ novel, world, onBack, onContinue }: WorldReviewProps) {
  const [guidance, setGuidance] = useState('');
  const [openSource, setOpenSource] = useState<string>();
  const visibleCharacters = world.characters.slice(0, 8);
  const visibleFacts = world.facts.slice(0, 6);

  return (
    <main className="setup-shell review-shell">
      <button className="back-link" onClick={onBack} type="button"><ArrowLeft size={16} /> 返回小说设置</button>
      <div className="review-layout">
        <section className="setup-card review-card">
          <div className="step-kicker"><span className="step-index">03</span> YOUR WORLD, UNDERSTOOD</div>
          <div className="review-title-row"><div className="setup-icon"><BookOpenCheck size={21} /></div><span className="confidence-badge"><span className="tiny-dot" /> 引用已核对</span></div>
          <h1>AI 读出了这本书</h1>
          <p className="setup-intro">AI 已分析整本小说。下面展示无剧透的世界理解；原著事实可以回到本机原文查看。</p>
          <div className="understanding-block">
            <span className="eyebrow">故事气质</span>
            <p className="understanding-lead">{world.premise}</p>
            <div className="tone-line"><span>叙事声音</span><strong>{world.tone}</strong></div>
            <div className="driver-list"><span className="eyebrow">故事靠什么向前</span><div>{world.narrativeDrivers.map((driver) => <span className="driver-chip" key={driver}>{driver}</span>)}</div></div>
          </div>
          <div className="review-section-head"><div><span className="eyebrow">PEOPLE IN THIS PART</span><h2>已经走进故事的人</h2></div><span className="count-pill"><Users size={14} /> {visibleCharacters.length}</span></div>
          <div className="character-grid">
            {visibleCharacters.map((character) => (
              <article className="character-card" key={character.id}>
                <span className="character-monogram">{character.name.slice(0, 1)}</span>
                <div><strong>{character.name}</strong><p>{character.summary}</p><small>第 {character.firstChapter} 章 · 原著角色</small></div>
              </article>
            ))}
          </div>
          <div className="review-section-head facts-head"><div><span className="eyebrow">GROUNDED IN THE BOOK</span><h2>故事依据</h2></div></div>
          <div className="fact-list">
            {visibleFacts.map((fact) => <article className="fact-item" key={fact.id}>
              <span className={`fact-type ${fact.kind}`}>{fact.kind === 'canon' ? '原著' : '推断'}</span><p>{fact.text}</p>
              {fact.kind === 'inference' && <small>AI 可信度 {Math.round((fact.confidence ?? 0) * 100)}%</small>}
              <button type="button" className="source-link" onClick={() => setOpenSource(openSource === fact.id ? undefined : fact.id)}><Quote size={13} /> 第 {fact.chapterNumber} 章 · 查看原文 <ChevronDown size={13} /></button>
              {openSource === fact.id && <blockquote className="source-quote">{findExcerpt(novel, fact.citations[0])?.text ?? '找不到本机原文片段。'}</blockquote>}
            </article>)}
          </div>
          <label className="field-label correction-field">你想补充或纠正什么？<span className="optional-label">可选</span>
            <textarea maxLength={1_000} value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="例如：两个人的关系应该慢慢升温，不要很快互相信任。" rows={3} />
            <small>这句话会跟随故事档案，在之后的互动中提醒 AI。</small>
          </label>
          <button type="button" className="primary-button full-button" onClick={() => onContinue(guidance)}>这就是我的世界 <ArrowRight size={17} /></button>
        </section>
        <aside className="review-aside"><div className="aside-stamp"><Sparkles size={16} /> A WORLD IN THE MAKING</div><div className="mini-book-art"><div className="book-glyph">书</div><span>VOL. 01&nbsp; / &nbsp;{world.chapterCount} CHAPTERS</span><h3>{novel.title}</h3><p>由你的行动<br />续写另一种可能</p><div className="book-rule" /></div><p className="aside-copy">原著是世界的底色。你写下的行动，会成为新的因果。</p></aside>
      </div>
    </main>
  );
}
