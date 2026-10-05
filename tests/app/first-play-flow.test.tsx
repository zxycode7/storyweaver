import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';

afterEach(() => vi.unstubAllGlobals());

function modelResponse(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
}

describe('first playable story flow', () => {
  it('connects a model, imports a novel, builds a grounded world, starts and saves a story', async () => {
    const user = userEvent.setup();
    let supportingExcerpt = '';
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)).messages as Array<{ role: string; content: string }>;
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const prompt = messages.find((message) => message.role === 'user')?.content ?? '';
      if (system.includes('Connection check')) return modelResponse({ connected: true });
      if (system.includes('小说资料分析器')) {
        supportingExcerpt = prompt.match(/<source id="([^"]+)"/)?.[1] ?? '';
        const chapter = Number(prompt.match(/chapter="(\d+)"/)?.[1] ?? 1);
        return modelResponse({ premiseSignal: '雨后的旧书店。', toneNotes: ['温柔克制'], narrativeDrivers: ['未说出口的话'],
          characters: [{ name: '林遥', summary: '经营旧书店。', citations: [supportingExcerpt] }],
          facts: [{ text: '林遥经营旧书店。', kind: 'canon', chapterNumber: chapter, citations: [supportingExcerpt] }], relationships: [], timeline: [] });
      }
      if (system.includes('小说玩法设计师')) return modelResponse({
        premise: '一段从雨后旧书店开始的相遇。', tone: '安静而温柔。', narrativeDrivers: ['那些没有说出口的话'],
        trackedStates: [{ id: 'trust', label: '信任', description: '林遥对玩家的信任程度。', initialValue: 0, min: 0, max: 5, citations: [supportingExcerpt] }],
        startSuggestions: [{ chapterNumber: 1, label: '雨后的书店', reason: '关系刚刚开始。' }],
      });
      const baseVersion = Number(prompt.match(/故事档案版本：(\d+)/)?.[1] ?? 0);
      const characterId = prompt.match(/"id":"(character-[^"]+)"/)?.[1] ?? '林遥';
      return modelResponse({ baseVersion, narration: baseVersion === 0 ? '雨停了，林遥把门口的灯打开。' : '她听完你的话，轻轻点了点头。',
        chapter: 1, worldTime: '雨后的傍晚', changes: baseVersion === 0 ? [] : [{ key: 'trust', value: 1, reason: '她愿意多相信你一些。' }],
        relevantCharacterIds: [characterId], changeSummary: baseVersion === 0 ? [] : ['林遥对你的信任增加了。'], citations: [supportingExcerpt] });
    });
    vi.stubGlobal('fetch', fakeFetch);

    render(<App />);
    await user.click(screen.getByRole('button', { name: /开始一个新故事/ }));
    await user.type(screen.getByLabelText('服务地址'), 'https://api.example.test/v1');
    await user.type(screen.getByLabelText('模型名称'), 'small-story-model');
    await user.type(screen.getByLabelText('API 密钥'), 'temporary-test-key');
    await user.click(screen.getByRole('button', { name: /测试连接并继续/ }));
    expect(await screen.findByRole('heading', { name: '带一本小说来' })).toBeInTheDocument();

    const novelFile = new File(['# 雨后书店\n\n第1章 灯亮起来\n林遥经营着一家旧书店。雨停时，一个陌生人推门进来。\n\n第2章 旧信\n门外的人带来一封旧信。'], 'rain.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('导入小说文件'), novelFile);
    expect(await screen.findByText(/2 个章节/)).toBeInTheDocument();
    expect(screen.queryByLabelText('你读到哪里了？')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByRole('heading', { name: '这本书会去哪里？' })).toBeInTheDocument();
    expect(screen.getByText(/整本小说用于建立世界资料/)).toBeInTheDocument();
    expect(screen.getByText(/整本小说用于建立世界资料/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /同意发送整本小说并建世界/ }));
    expect(await screen.findByRole('heading', { name: 'AI 读出了这本书' })).toBeInTheDocument();
    expect(screen.getByText('一段从雨后旧书店开始的相遇。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '这就是我的世界' }));
    expect(await screen.findByRole('heading', { name: '从哪里进入？' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('新人物叫什么？'), '许知遥');
    await user.click(screen.getByRole('button', { name: '走进故事' }));
    expect(await screen.findByText('许知遥 的故事')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /生成开场/ }));
    expect(await screen.findByText('雨停了，林遥把门口的灯打开。')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('写下你想做的事、说的话，或一个念头…'), '我帮她把门口的书搬进来。');
    await user.click(screen.getByRole('button', { name: '发送行动' }));
    expect(await screen.findByText('她听完你的话，轻轻点了点头。')).toBeInTheDocument();
    expect(screen.getByText('林遥对你的信任增加了。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /我的故事/ }));
    const savedCard = await screen.findByRole('button', { name: /许知遥 的故事.*雨.md|许知遥 的故事.*雨后书店/ });
    expect(within(savedCard).getByText(/许知遥 的故事/)).toBeInTheDocument();
    await waitFor(() => expect(fakeFetch).toHaveBeenCalledTimes(5));
  });
});
