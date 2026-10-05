import { useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Feather, Heart, UserRound, WandSparkles } from 'lucide-react';
import type { StorySetup } from '../domain/story';
import type { WorldModel } from '../domain/world';

interface StorySetupProps {
  world: WorldModel;
  guidance: string;
  onBack: () => void;
  onStart: (setup: StorySetup) => Promise<void>;
}

const DIFFICULTIES = [
  { value: 'relaxed', title: '轻松', note: '让意外带来新方向，少一些惩罚。' },
  { value: 'balanced', title: '刚刚好', note: '选择有分量，故事总有继续的路。' },
  { value: 'high-stakes', title: '高压', note: '关系与机会都可能真的失去。' },
] as const;

export default function StorySetup({ world, guidance, onBack, onStart }: StorySetupProps) {
  const characters = useMemo(() => [...world.characters].sort((a, b) => a.firstChapter - b.firstChapter).slice(0, 8), [world]);
  const [role, setRole] = useState('original');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const firstSuggested = world.startSuggestions[0]?.chapterNumber ?? 1;
  const [startChapter, setStartChapter] = useState(firstSuggested);
  const [difficulty, setDifficulty] = useState<StorySetup['difficulty']>('balanced');
  const [title, setTitle] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const selectedCharacter = characters.find((character) => character.id === role);
  const earliestStart = selectedCharacter?.firstChapter ?? 1;

  const handleRole = (next: string) => {
    setRole(next);
    const character = characters.find((item) => item.id === next);
    if (character && startChapter < character.firstChapter) setStartChapter(character.firstChapter);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setStarting(true);
    try {
      await onStart({
        title, startChapter, difficulty, guidance,
        player: selectedCharacter
          ? { kind: 'character', characterId: selectedCharacter.id, name: selectedCharacter.name }
          : { kind: 'original', name: name.trim(), description: description.trim() },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建故事线失败。');
    } finally {
      setStarting(false);
    }
  };

  return (
    <main className="setup-shell">
      <button className="back-link" onClick={onBack} type="button"><ArrowLeft size={16} /> 返回世界理解</button>
      <div className="setup-card story-setup-card">
        <div className="step-kicker"><span className="step-index">04</span> MAKE IT YOUR STORY</div>
        <div className="setup-icon"><Feather size={21} /></div>
        <h1>从哪里进入？</h1>
        <p className="setup-intro">不用填写角色卡。选择一个熟悉的人，或用一句话让一个新人物走进来。</p>
        <form onSubmit={submit} className="form-stack">
          <div className="field-label">你想成为谁？</div>
          <div className="role-grid">
            <button type="button" className={`role-card ${role === 'original' ? 'selected' : ''}`} onClick={() => handleRole('original')}>
              <span className="role-icon"><WandSparkles size={17} /></span><strong>一个新人物</strong><small>在原著没有写到的地方相遇</small>
            </button>
            {characters.map((character) => <button type="button" className={`role-card ${role === character.id ? 'selected' : ''}`} onClick={() => handleRole(character.id)} key={character.id}>
              <span className="role-icon"><UserRound size={17} /></span><strong>{character.name}</strong><small>{character.summary}</small>
            </button>)}
          </div>
          {!selectedCharacter && <div className="original-fields">
            <label className="field-label">新人物叫什么？<input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="取一个名字" /></label>
            <label className="field-label">一句话介绍 <span className="optional-label">可选</span><input maxLength={300} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="比如：在街角新开了一家花店" /></label>
          </div>}
          <div className="field-row">
            <label className="field-label">故事从哪里开始？
              <select value={startChapter} onChange={(event) => setStartChapter(Number(event.target.value))}>
                {world.startSuggestions.filter((item) => item.chapterNumber >= earliestStart).map((item) => <option key={`${item.chapterNumber}-${item.label}`} value={item.chapterNumber}>第 {item.chapterNumber} 章 · {item.label}</option>)}
                {Array.from({ length: Math.max(0, world.chapterCount - earliestStart + 1) }, (_, index) => earliestStart + index)
                  .filter((chapterNumber) => !world.startSuggestions.some((item) => item.chapterNumber === chapterNumber))
                  .map((chapterNumber) => <option key={chapterNumber} value={chapterNumber}>第 {chapterNumber} 章</option>)}
              </select>
            </label>
            <label className="field-label">给这条故事线起名 <span className="optional-label">可选</span>
              <input maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="默认用人物名字命名" />
            </label>
          </div>
          <div className="field-label">故事会有多大风险？<span className="optional-label">可以之后调整</span></div>
          <div className="difficulty-grid">
            {DIFFICULTIES.map((option) => <button key={option.value} type="button" className={`difficulty-card ${difficulty === option.value ? 'selected' : ''}`} onClick={() => setDifficulty(option.value)}>
              <span className="difficulty-icon">{option.value === 'relaxed' ? <Heart size={16} /> : option.value === 'balanced' ? <SparkleIcon /> : <WandSparkles size={16} />}</span><strong>{option.title}</strong><small>{option.note}</small>
            </button>)}
          </div>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <button type="submit" className="primary-button full-button" disabled={starting || (!selectedCharacter && !name.trim())}>
            {starting ? <><span className="spinner" /> 正在保存</> : <>走进故事 <ArrowRight size={17} /></>}
          </button>
        </form>
      </div>
    </main>
  );
}

function SparkleIcon() {
  return <span aria-hidden="true" className="balanced-glyph">✳</span>;
}
