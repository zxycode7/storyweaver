export const MAX_NOVEL_BYTES = 25 * 1024 * 1024;
export const MAX_NOVEL_SIZE_LABEL = '25 MiB';
const MAX_EXCERPT_CHARS = 4_000;

export interface NovelExcerpt {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface NovelChapter {
  id: string;
  number: number;
  title: string;
  text: string;
  startOffset: number;
  endOffset: number;
  excerpts: NovelExcerpt[];
}

export interface ParsedNovel {
  id: string;
  title: string;
  filename: string;
  charCount: number;
  chapters: NovelChapter[];
}

interface HeadingMatch {
  index: number;
  end: number;
  title: string;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function detectMarkdownTitle(text: string): { title?: string; start: number } {
  const match = text.match(/^\s*#\s+(.+?)\s*(?:\r?\n|$)/);
  if (!match || match.index === undefined) return { start: 0 };
  return { title: match[1].trim(), start: match.index + match[0].length };
}

function findHeadings(text: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const headingPattern = /^[ \t]*(?:第[ \t]*[0-9０-９一二三四五六七八九十百千万零〇两]+[ \t]*章[ \t]*([^\r\n]*)|Chapter[ \t]+(?:\d+|[A-Za-z]+)[ \t]*[:：.、-]?[ \t]*([^\r\n]*))[ \t]*$/gim;
  for (const match of text.matchAll(headingPattern)) {
    if (match.index === undefined) continue;
    const firstNewline = text.indexOf('\n', match.index);
    const end = firstNewline === -1 ? text.length : firstNewline + 1;
    headings.push({ index: match.index, end, title: (match[1] || match[2] || '').trim() });
  }
  return headings;
}

function splitExcerptRanges(text: string, baseOffset: number): Array<{ start: number; end: number }> {
  if (!text.length) return [{ start: baseOffset, end: baseOffset }];
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + MAX_EXCERPT_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(cursor, end);
      const paragraphBoundary = window.lastIndexOf('\n\n');
      const lineBoundary = window.lastIndexOf('\n');
      const boundary = paragraphBoundary > 1_000 ? paragraphBoundary + 2 : lineBoundary > 1_000 ? lineBoundary + 1 : window.length;
      end = cursor + boundary;
    }
    if (end <= cursor) end = Math.min(cursor + MAX_EXCERPT_CHARS, text.length);
    ranges.push({ start: baseOffset + cursor, end: baseOffset + end });
    cursor = end;
  }
  return ranges;
}

function makeChapter(source: string, number: number, title: string, start: number, end: number): NovelChapter {
  const text = source.slice(start, end).trim();
  const leadingTrim = source.slice(start, end).search(/\S|$/);
  const contentStart = start + Math.max(leadingTrim, 0);
  const ranges = splitExcerptRanges(text, contentStart);
  const chapterId = `chapter-${number}-${hash(`${number}:${title}:${text}`)}`;
  const excerpts = ranges.map((range, index) => {
    const excerptText = source.slice(range.start, range.end).trim();
    const leading = source.slice(range.start, range.end).search(/\S|$/);
    const trailing = source.slice(range.start, range.end).length - source.slice(range.start, range.end).trimEnd().length;
    const excerptStart = range.start + Math.max(leading, 0);
    const excerptEnd = range.end - trailing;
    return {
      id: `${chapterId}-excerpt-${index + 1}-${hash(excerptText)}`,
      text: excerptText,
      startOffset: excerptStart,
      endOffset: excerptEnd,
    };
  });
  return { id: chapterId, number, title, text, startOffset: start, endOffset: end, excerpts };
}

export function parseNovelText(input: string, filename: string): ParsedNovel {
  if (byteLength(input) > MAX_NOVEL_BYTES) {
    throw new Error(`小说文件超过 ${MAX_NOVEL_SIZE_LABEL} 上限，请先拆分文件再导入。`);
  }
  const source = input.replace(/^\uFEFF/, '');
  const markdown = detectMarkdownTitle(source);
  const title = markdown.title || filename.replace(/\.[^.]+$/, '').trim() || '未命名小说';
  const headings = findHeadings(source).filter((heading) => heading.index >= markdown.start);
  const chapters: NovelChapter[] = [];

  if (headings.length > 0) {
    const preamble = source.slice(markdown.start, headings[0].index).trim();
    if (preamble) chapters.push(makeChapter(source, 1, '序章', markdown.start, headings[0].index));
    headings.forEach((heading, index) => {
      const next = headings[index + 1];
      const end = next?.index ?? source.length;
      const fallbackTitle = `第 ${index + 1} 章`;
      chapters.push(makeChapter(source, chapters.length + 1, heading.title || fallbackTitle, heading.end, end));
    });
  } else {
    chapters.push(makeChapter(source, 1, '正文', markdown.start, source.length));
  }

  return {
    id: `novel-${hash(source)}`,
    title,
    filename,
    charCount: source.length,
    chapters,
  };
}

export function findExcerpt(novel: ParsedNovel, excerptId: string): NovelExcerpt | undefined {
  for (const chapter of novel.chapters) {
    const excerpt = chapter.excerpts.find((candidate) => candidate.id === excerptId);
    if (excerpt) return excerpt;
  }
  return undefined;
}
