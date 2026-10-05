import { describe, expect, it } from 'vitest';
import { MAX_NOVEL_BYTES, parseNovelText } from '../../src/domain/novel';

describe('parseNovelText', () => {
  it('splits Chinese chapter headings and preserves stable source IDs', () => {
    const text = '# 星河旧事\n\n第1章 雨夜\n雨夜里，故事开始了。\n\n第2章 清晨\n清晨时，故事继续。';
    const first = parseNovelText(text, 'novel.md');
    const second = parseNovelText(text, 'novel.md');
    expect(first.title).toBe('星河旧事');
    expect(first.chapters.map((chapter) => chapter.title)).toEqual(['雨夜', '清晨']);
    expect(first.chapters[0].id).toBe(second.chapters[0].id);
    expect(first.chapters[0].excerpts[0].text).toContain('故事开始了');
  });

  it('detects English chapters and splits unheaded text into bounded excerpts', () => {
    const headed = parseNovelText('Chapter One: Arrival\nA first scene.\nChapter 2\nA second scene.', 'book.txt');
    expect(headed.chapters).toHaveLength(2);
    expect(headed.chapters[0].title).toBe('Arrival');

    const text = `${'甲'.repeat(2500)}\n\n${'乙'.repeat(2500)}`;
    const fallback = parseNovelText(text, 'untitled.txt');
    expect(fallback.chapters).toHaveLength(1);
    expect(fallback.chapters[0].excerpts.length).toBeGreaterThan(1);
    expect(fallback.chapters[0].excerpts[0].startOffset).toBe(0);
  });

  it('rejects files above the supported limit', () => {
    expect(MAX_NOVEL_BYTES).toBeGreaterThan(10 * 1024 * 1024);
    expect(() => parseNovelText('x'.repeat(MAX_NOVEL_BYTES + 1), 'huge.txt')).toThrow(/25 MiB/i);
  });

  it('accepts a novel larger than 10 MiB and retains its text as bounded source excerpts', () => {
    const longNovel = `${'a'.repeat(10 * 1024 * 1024)}\n\n尾声。`;
    const parsed = parseNovelText(longNovel, 'long-book.txt');
    expect(parsed.charCount).toBe(longNovel.length);
    expect(parsed.chapters[0].excerpts.length).toBeGreaterThan(2_000);
    expect(parsed.chapters[0].excerpts.at(-1)?.text).toContain('尾声');
  });
});
