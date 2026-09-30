import crypto from 'node:crypto';
import { getDb } from '../db.js';
import {
  IMPORT_TIME_TOLERANCE_MS,
  addTags,
  createInspiration,
  mergeInspirations,
  titleKeyOf,
  touch,
} from './inspirations.js';
import type { InspirationRow } from './serialization.js';

export type InboxMatchKey = 'image_fingerprint' | 'title_time';

export interface InboxMatch {
  inspirationId: string;
  matchKey: InboxMatchKey;
  /** image_fingerprint 命中时给出已存在的素材 id 与指纹 */
  assetId?: string;
  sha256?: string;
}

export interface InboxProbe {
  /** 图片字节指纹（入参给了图片就算得出） */
  sha256: string | null;
  /** 指纹已在本库存在（不区分挂在哪张卡上——同一张图不应入第二次） */
  assetExists: boolean;
  match: InboxMatch | null;
}

/**
 * 收件箱归并探测：按"图片指纹 → 标题+时间"的顺序找同一条。
 *
 * - 图片指纹：asset.sha256 精确相等即视为重复（哪怕标题改了）。
 * - 标题+时间：归一化标题相等，且发生时间在容差窗口内。没有发生时间的卡不参与时间归并，
 *   避免"只有标题相同的两张随手卡"被错误并掉。
 * - 已终态（archived/dropped）的卡不作为归并目标——重复导入不应复活一张被人主动放弃的卡。
 */
export function probeInboxDuplicate(
  libraryId: string,
  params: { title: string; occurredAt?: string | null; sha256?: string | null },
): InboxProbe {
  const db = getDb();
  const sha256 = params.sha256 ?? null;
  let match: InboxMatch | null = null;
  let assetExists = false;

  if (sha256) {
    const asset = db
      .prepare(
        `SELECT a.id, a.inspiration_id, i.status, i.deleted_at
         FROM asset a JOIN inspiration i ON i.id = a.inspiration_id
         WHERE a.library_id = ? AND a.sha256 = ?
         ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(libraryId, sha256) as
      | { id: string; inspiration_id: string; status: string; deleted_at: string | null }
      | undefined;
    if (asset) {
      assetExists = true;
      const live = asset.deleted_at == null && !['archived', 'dropped'].includes(asset.status);
      if (live) {
        match = { inspirationId: asset.inspiration_id, matchKey: 'image_fingerprint', assetId: asset.id, sha256 };
      }
    }
  }

  if (!match && params.occurredAt) {
    const t = new Date(params.occurredAt).getTime();
    if (Number.isFinite(t)) {
      const rows = db
        .prepare(
          `SELECT * FROM inspiration
           WHERE library_id = ? AND title_key = ? AND occurred_at IS NOT NULL
             AND deleted_at IS NULL AND status NOT IN ('archived','dropped')`,
        )
        .all(libraryId, titleKeyOf(params.title)) as InspirationRow[];
      for (const row of rows) {
        const occurredAt = (row as Record<string, unknown>).occurred_at as string;
        const delta = Math.abs(new Date(occurredAt).getTime() - t);
        if (delta <= IMPORT_TIME_TOLERANCE_MS) {
          match = { inspirationId: row.id, matchKey: 'title_time' };
          break;
        }
      }
    }
  }

  return { sha256, assetExists, match };
}

export function sha256OfBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export interface ImportableItem {
  title: string;
  note?: string | null;
  occurredAt?: string | null;
  tagIds?: string[];
  /** 图片：buffer 与已算好的指纹（指纹也可在 route 层预算后传入） */
  files?: { filename: string; buffer: Buffer; sha256?: string }[];
}

export interface ImportItemResult {
  inspirationId: string;
  duplicated: boolean;
  matchKey: InboxMatchKey | null;
  /** true = 图片指纹在库内已存在，连素材都没有重复落盘/落库 */
  assetSkipped: boolean;
  importedAssetIds: string[];
  skippedAssetCount: number;
  tagsAdded: number;
}

/**
 * 收件箱导入单条（幂等）：
 * 1. 有图先算指纹；指纹命中 → 直接归并，相同图片不再落第二份素材；
 * 2. 否则标题+时间命中 → 归并，新图照常并入；
 * 3. 都不命中 → 新建收件箱卡片。
 * 归并走 mergeInspirations 的全量保留路径，因此标签、素材、窗口历史完整保留。
 *
 * ingestAsset 由调用方注入（避免本服务依赖 sharp 管线，也方便测试）。
 */
export async function importToInbox(
  libraryId: string,
  item: ImportableItem,
  ingest: (params: {
    libraryId: string;
    inspirationId: string;
    filename: string;
    buffer: Buffer;
    sha256: string;
  }) => Promise<{ assetId: string }>,
): Promise<ImportItemResult> {
  const files = (item.files ?? []).map((f) => ({
    ...f,
    sha256: f.sha256 ?? sha256OfBuffer(f.buffer),
  }));
  const firstSha = files[0]?.sha256 ?? null;

  const probe = probeInboxDuplicate(libraryId, {
    title: item.title,
    occurredAt: item.occurredAt ?? null,
    sha256: firstSha,
  });

  // 指纹命中：什么都不新建。其余图片若也是库内已有指纹，同样跳过。
  if (probe.match?.matchKey === 'image_fingerprint') {
    const keepId = probe.match.inspirationId;
    let skipped = files.length;
    const imported: string[] = [];
    for (const f of files.slice(1)) {
      const p = probeInboxDuplicate(libraryId, { title: item.title, occurredAt: item.occurredAt ?? null, sha256: f.sha256 });
      if (p.assetExists) continue;
      const a = await ingest({ libraryId, inspirationId: keepId, filename: f.filename, buffer: f.buffer, sha256: f.sha256 });
      imported.push(a.assetId);
      skipped -= 1;
    }
    touch(keepId);
    return {
      inspirationId: keepId,
      duplicated: true,
      matchKey: 'image_fingerprint',
      assetSkipped: true,
      importedAssetIds: imported,
      skippedAssetCount: skipped,
      tagsAdded: 0,
    };
  }

  if (probe.match?.matchKey === 'title_time') {
    const keepId = probe.match.inspirationId;
    const dupId = createInspiration({
      libraryId,
      title: item.title,
      note: item.note ?? null,
      occurredAt: item.occurredAt ?? null,
    });
    const imported: string[] = [];
    for (const f of files) {
      const p = probeInboxDuplicate(libraryId, { title: item.title, occurredAt: item.occurredAt ?? null, sha256: f.sha256 });
      if (p.assetExists) continue;
      const a = await ingest({ libraryId, inspirationId: dupId, filename: f.filename, buffer: f.buffer, sha256: f.sha256 });
      imported.push(a.assetId);
    }
    // 标签先打到来源卡，再随归并完整并入 keep（usage_count 由归并逻辑修正）
    const tagsAdded = item.tagIds?.length ? attachTags(dupId, item.tagIds) : 0;
    mergeInspirations(keepId, [dupId], { code: 'title_time' });
    touch(keepId);
    return {
      inspirationId: keepId,
      duplicated: true,
      matchKey: 'title_time',
      assetSkipped: false,
      importedAssetIds: imported,
      skippedAssetCount: files.length - imported.length,
      tagsAdded,
    };
  }

  // 全新条目：但仍要防御同一次导入里带了两张库内已有指纹的图
  const id = createInspiration({
    libraryId,
    title: item.title,
    note: item.note ?? null,
    occurredAt: item.occurredAt ?? null,
  });
  const imported: string[] = [];
  let skipped = 0;
  for (const f of files) {
    const p = probeInboxDuplicate(libraryId, { title: item.title, occurredAt: item.occurredAt ?? null, sha256: f.sha256 });
    if (p.assetExists) {
      skipped += 1;
      continue;
    }
    const a = await ingest({ libraryId, inspirationId: id, filename: f.filename, buffer: f.buffer, sha256: f.sha256 });
    imported.push(a.assetId);
  }
  const tagsAdded = item.tagIds?.length ? attachTags(id, item.tagIds) : 0;
  touch(id);
  return {
    inspirationId: id,
    duplicated: false,
    matchKey: null,
    assetSkipped: false,
    importedAssetIds: imported,
    skippedAssetCount: skipped,
    tagsAdded,
  };
}

function attachTags(inspirationId: string, tagIds: string[]): number {
  const db = getDb();
  const valid = (
    tagIds
      .map((id) => db.prepare('SELECT id FROM tag WHERE id = ?').get(id) as { id: string } | undefined)
      .filter(Boolean) as { id: string }[]
  ).map((r) => r.id);
  return addTags(inspirationId, valid, 'bulk');
}
