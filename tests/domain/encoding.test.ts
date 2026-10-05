import { describe, expect, it } from 'vitest';
import { decodeNovelBytes } from '../../src/domain/encoding';
import { parseNovelText } from '../../src/domain/novel';

describe('decodeNovelBytes', () => {
  it('decodes UTF-8 text without mangling Chinese characters', async () => {
    await expect(decodeNovelBytes(new TextEncoder().encode('雨停以后，林遥打开了书店的灯。'))).resolves.toBe('雨停以后，林遥打开了书店的灯。');
  });

  it('detects and decodes legacy GBK/GB18030 Chinese text', async () => {
    const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
    await expect(decodeNovelBytes(gbk)).resolves.toBe('中文测试');
  });

  it('preserves a legacy encoded novel preview instead of showing replacement glyphs', async () => {
    const bytes = Uint8Array.from(Buffer.from('b5da31d5c220b5c6c1c1c6f0c0b40ac1d6d2a3beadd3aad7c5d2bbbcd2bec9cae9b5eaa1a3', 'hex'));
    const parsed = parseNovelText(await decodeNovelBytes(bytes), 'legacy.txt');
    expect(parsed.chapters[0].title).toBe('灯亮起来');
    expect(parsed.chapters[0].text).toContain('林遥经营着一家旧书店');
    expect(parsed.chapters[0].text).not.toContain('�');
  });

  it('uses a BOM to decode UTF-16 text', async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0xe8, 0x96, 0x0e, 0x54]);
    await expect(decodeNovelBytes(bytes)).resolves.toBe('雨后');
  });

  it('reports when the file cannot be decoded safely', async () => {
    await expect(decodeNovelBytes(Uint8Array.from([0x81]))).rejects.toThrow(/编码|encoding/i);
  });
});
