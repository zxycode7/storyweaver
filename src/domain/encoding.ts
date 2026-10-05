const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16_LE_BOM = [0xff, 0xfe] as const;
const UTF16_BE_BOM = [0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function decode(bytes: Uint8Array, encoding: string): string {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    const suspicious = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/g)?.length ?? 0;
    if (text.length > 0 && suspicious / text.length > 0.001) throw new Error('suspicious decoded controls');
    return text;
  } catch {
    throw new Error(`无法按 ${encoding} 编码安全读取该小说，请另存为 UTF-8 后重试。`);
  }
}

export async function decodeNovelBytes(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (startsWith(bytes, UTF8_BOM)) return decode(bytes, 'utf-8');
  if (startsWith(bytes, UTF16_LE_BOM)) return decode(bytes.subarray(2), 'utf-16le');
  if (startsWith(bytes, UTF16_BE_BOM)) return decode(bytes.subarray(2), 'utf-16be');

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Older Chinese novels are commonly exported as GBK/GB18030 or Big5.
  }

  const { default: jschardet } = await import('jschardet');
  const detected = jschardet.detect(bytes.subarray(0, Math.min(bytes.length, 65_536)));
  const normalized = detected.encoding?.trim().toLowerCase().replace(/[_ ]/g, '-') ?? '';
  const aliases: Record<string, string> = {
    gb2312: 'gb18030',
    gbk: 'gb18030',
    'gb-2312': 'gb18030',
    'x-gbk': 'gb18030',
    big5: 'big5',
    'big5-hkscs': 'big5-hkscs',
    'shift-jis': 'shift_jis',
    sjis: 'shift_jis',
    'euc-kr': 'euc-kr',
    'windows-1252': 'windows-1252',
    'iso-8859-1': 'windows-1252',
  };
  const encoding = normalized === 'gb18030' ? 'gb18030' : aliases[normalized];
  if (!encoding || detected.confidence < 0.01) {
    throw new Error('无法识别小说文件编码。请用文本编辑器将文件另存为 UTF-8 后再导入。');
  }
  return decode(bytes, encoding);
}
