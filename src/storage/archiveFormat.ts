import { validateStoryAgainstWorld, type StoryArchive } from '../domain/story';
import { validateWorldSnapshot, type WorldModel } from '../domain/world';

const FORMAT = 'storyweaver-story';
const VERSION = 1;
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;

export interface ImportedStoryBundle {
  story: StoryArchive;
  world: WorldModel;
}

export function exportArchive(story: StoryArchive, world: WorldModel): Blob {
  const validatedWorld = validateWorldSnapshot(world);
  const validatedStory = validateStoryAgainstWorld(story, validatedWorld);
  const payload = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), story: validatedStory, world: validatedWorld };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('档案读取失败。'));
    reader.readAsText(file);
  });
}

export async function importArchive(file: File): Promise<ImportedStoryBundle> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('故事档案超过 5 MiB 上限。');
  let payload: unknown;
  try {
    payload = JSON.parse(await readText(file));
  } catch {
    throw new Error('故事档案无法读取，请选择有效的 JSON 档案。');
  }
  if (!payload || typeof payload !== 'object') throw new Error('故事档案格式无效。');
  const data = payload as { format?: unknown; version?: unknown; story?: unknown; world?: unknown };
  if (data.format !== FORMAT) throw new Error('这不是 Storyweaver 故事档案。');
  if (data.version !== VERSION) throw new Error(`不支持故事档案版本 ${String(data.version)}。`);
  try {
    const world = validateWorldSnapshot(data.world);
    const story = validateStoryAgainstWorld(data.story, world);
    return { story, world };
  } catch {
    throw new Error('故事档案数据损坏或字段不完整，无法恢复。');
  }
}
