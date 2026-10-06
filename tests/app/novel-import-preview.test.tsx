import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import NovelImport from '../../src/components/NovelImport';

describe('novel import preview', () => {
  it('shows readable Markdown and inline HTML while retaining the original source', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const file = new File([
      '# 雨夜\n\n<div align="center">星光</div>\n\n**林遥** [店铺](https://example.com) &amp; 旧信',
    ], 'novel.md', { type: 'text/markdown' });
    render(<NovelImport onBack={() => undefined} onContinue={onContinue} />);

    await user.upload(screen.getByLabelText('导入小说文件'), file);

    expect(await screen.findByText('星光 林遥 店铺 & 旧信')).toBeInTheDocument();
    expect(screen.queryByText(/<div|https:\/\/example\.com/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续' }));
    expect(onContinue.mock.calls[0][0].chapters[0].excerpts[0].text).toContain('<div align="center">');
  });
});
