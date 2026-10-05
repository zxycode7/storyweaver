import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { parseNovelText } from '../../src/domain/novel';
import { StoryRepository } from '../../src/storage/storyRepository';

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => deleteDatabase('storyweaver-local'));
afterEach(async () => deleteDatabase('storyweaver-local'));

describe('world-build recovery', () => {
  it('shows a saved world build on the home screen after reopening the app', async () => {
    const user = userEvent.setup();
    const novel = parseNovelText('第1章 相遇\n林遥经营一家旧书店。', 'rain.txt');
    const repository = new StoryRepository();
    await repository.saveNovel(novel);
    await repository.saveWorldBuildCheckpoint({
      id: `world-build-${novel.id}`, novelId: novel.id, signature: 'stored-signature', digests: { 0: { premiseSignal: '雨后的书店。' } }, updatedAt: new Date().toISOString(),
    });

    render(<App />);

    const resume = await screen.findByRole('button', { name: /继续整理.*rain\.txt/ });
    expect(resume).toHaveTextContent('1 份已保存');
    await user.click(resume);
    expect(await screen.findByRole('heading', { name: '先接入你的 AI' })).toBeInTheDocument();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"connected":true}' } }] }), { status: 200 })));
    await user.type(screen.getByLabelText('服务地址'), 'https://api.example.test/v1');
    await user.type(screen.getByLabelText('模型名称'), 'demo-model');
    await user.type(screen.getByLabelText('API 密钥'), 'local-test-key');
    await user.click(screen.getByRole('button', { name: /测试连接并继续/ }));
    expect(await screen.findByRole('heading', { name: '这本书会去哪里？' })).toBeInTheDocument();
    expect(screen.getByText(/《rain》共 1 章/)).toBeInTheDocument();
  });
});
