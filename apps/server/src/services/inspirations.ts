import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import type { InspirationRow } from './serialization.js';
import { recomputeHitRate } from './calibration.js';

/** 标题归一化键：与 slugify 同源但保留中文/数字，去掉空白与标点差异（"黄昏 逆光" == "黄昏，逆光"） */
export function titleKeyOf(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[\s/|·、，,。.！!？?：:；;「」『』【】\[\]（）()'"“”‘’~～-]+/g, '') ||
    `t-${Buffer.from(title.trim()).toString('hex').slice(0, 12)}`
  );
}

/** 时间归并容差：同一标题在 ±90 分钟内出现视为同一条（连拍/跨设备导入的时钟漂移） */
export const IMPORT_TIME_TOLERANCE_MS = 90 * 60 * 1000;

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[\s/|·、，,。.]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || `t-${Buffer.from(name).toString('hex').slice(0, 8)}`;
}

export function requireInspiration(id: string, libraryId: string): InspirationRow {
  const row = getDb()
    .prepare('SELECT * FROM inspiration WHERE id = ? AND deleted_at IS NULL')
    .get(id) as InspirationRow | undefined;
  if (!row) throw errors.notFound('灵感卡');
  if (row.library_id !== libraryId) throw errors.scopeDenied();
  return row;
}

export function touch(id: string): void {
  getDb().prepare('UPDATE inspiration SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

export function tagCountOf(inspirationId: string): number {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE inspiration_id = ?')
    .get(inspirationId) as { n: number };
  return r.n;
}

export function hasTiming(inspirationId: string): boolean {
  const r = getDb().prepare('SELECT 1 AS x FROM timing WHERE inspiration_id = ?').get(inspirationId);
  return Boolean(r);
}

/**
 * 状态机（文档 6.1）：所有状态变更都从这里走，保证没有"断头状态"。
 * 终态（archived / dropped）不会被自动改写。
 */
export function syncStatus(inspirationId: string): InspirationRow['status'] {
  const db = getDb();
  const row = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(inspirationId) as
    | InspirationRow
    | undefined;
  if (!row) throw errors.notFound('灵感卡');
  if (row.status === 'archived' || row.status === 'dropped') return row.status;

  const hasPlan = Boolean(
    db
      .prepare('SELECT 1 AS x FROM shoot_plan WHERE inspiration_id = ? AND status != ?')
      .get(inspirationId, 'cancelled'),
  );
  const hasResult = Boolean(
    db.prepare('SELECT 1 AS x FROM shoot_result WHERE inspiration_id = ?').get(inspirationId),
  );
  const assetCount = (
    db.prepare('SELECT COUNT(*) AS n FROM asset WHERE inspiration_id = ?').get(inspirationId) as { n: number }
  ).n;

  let status: InspirationRow['status'];
  if (hasResult) status = 'shot';
  else if (hasPlan) status = 'scheduled';
  else if (!hasTiming(inspirationId)) {
    status = tagCountOf(inspirationId) > 0 || assetCount > 0 ? 'timing_missing' : 'draft';
  } else if (tagCountOf(inspirationId) === 0) {
    status = 'tagging';
  } else {
    status = 'ready';
  }

  if (status !== row.status) {
    db.prepare('UPDATE inspiration SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      nowIso(),
      inspirationId,
    );
  }
  return status;
}

export function createInspiration(params: {
  libraryId: string;
  title: string;
  note?: string | null;
  seasonTags?: number[];
  /** 发生时间（通常取图片 EXIF 拍摄时刻），收件箱按它做时间维度归并 */
  occurredAt?: string | null;
}): string {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO inspiration (id, library_id, title, note, status, season_tags, hit_count, partial_count,
       miss_count, hit_rate, title_key, occurred_at, created_at, updated_at)
     VALUES (?,?,?,?, 'draft', ?, 0,0,0,0, ?, ?, ?, ?)`,
  ).run(
    id,
    params.libraryId,
    params.title,
    params.note ?? null,
    toJson(params.seasonTags ?? []),
    titleKeyOf(params.title),
    params.occurredAt ?? null,
    ts,
    ts,
  );
  reindexFts(id);
  return id;
}

/** PATCH 标题 / 发生时间时同步归并键 */
export function setMergeKeys(id: string, patch: { title?: string; occurredAt?: string | null }): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push('title_key = ?');
    args.push(titleKeyOf(patch.title));
  }
  if (patch.occurredAt !== undefined) {
    sets.push('occurred_at = ?');
    args.push(patch.occurredAt);
  }
  if (!sets.length) return;
  getDb().prepare(`UPDATE inspiration SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]), id);
}

export function addTags(
  inspirationId: string,
  tagIds: string[],
  source: 'manual' | 'bulk' | 'album_gap' | 'suggested' = 'manual',
): number {
  const db = getDb();
  const ts = nowIso();
  let added = 0;
  const stmt = db.prepare(
    `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?,?,?)
     ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
  );
  const run = db.transaction(() => {
    for (const tagId of tagIds) {
      const res = stmt.run(inspirationId, tagId, source, ts);
      if (res.changes > 0) {
        added += 1;
        db.prepare('UPDATE tag SET usage_count = usage_count + 1 WHERE id = ?').run(tagId);
      }
    }
  });
  run();
  if (added) {
    touch(inspirationId);
    reindexFts(inspirationId);
  }
  syncStatus(inspirationId);
  return added;
}

export function removeTags(inspirationId: string, tagIds: string[]): number {
  const db = getDb();
  let removed = 0;
  const run = db.transaction(() => {
    for (const tagId of tagIds) {
      const res = db
        .prepare('DELETE FROM inspiration_tag WHERE inspiration_id = ? AND tag_id = ?')
        .run(inspirationId, tagId);
      if (res.changes > 0) {
        removed += 1;
        db.prepare('UPDATE tag SET usage_count = MAX(0, usage_count - 1) WHERE id = ?').run(tagId);
      }
    }
  });
  run();
  if (removed) {
    touch(inspirationId);
    reindexFts(inspirationId);
  }
  syncStatus(inspirationId);
  return removed;
}

export function setSpot(inspirationId: string, spotId: string | null): void {
  getDb()
    .prepare('UPDATE inspiration SET spot_id = ?, updated_at = ? WHERE id = ?')
    .run(spotId, nowIso(), inspirationId);
  syncStatus(inspirationId);
}

export function archiveInspiration(id: string, reason: string | null): void {
  getDb()
    .prepare('UPDATE inspiration SET status = ?, archived_reason = ?, updated_at = ? WHERE id = ?')
    .run('archived', reason, nowIso(), id);
}

export function dropInspiration(id: string, reason: string): void {
  getDb()
    .prepare('UPDATE inspiration SET status = ?, archived_reason = ?, updated_at = ? WHERE id = ?')
    .run('dropped', reason, nowIso(), id);
}

export type MergeMatchKey = 'image_fingerprint' | 'title_time' | 'manual' | 'reimport';

/**
 * 合并重复卡（文档 9.2 + 收件箱归并）：keep 为保留卡，mergeIds 全部并入后进入终态 dropped。
 *
 * 与旧版只搬标签/图片不同，这里做**全量保留**——合并不是删数据：
 * - 标签：并集，tag.usage_count 同步修正
 * - 素材：asset（含构图标注，随 asset 级联）整体改挂
 * - 条件：keep 无条件时直接接管；双方都有时把来源条件摘要追加进 notes
 * - 窗口历史：repro_window 整体改挂；同日同时段冲突时先把引用计划改指向保留窗口再去重
 * - 计划 / 回填 / 校准日志 / 分享链接：改挂保留卡
 * - 提醒：改挂；occurrence_key 冲突时保留更"待办"的一条
 * - 画册成员：并集；同画册去重，手动说明优先
 * - 命中率统计：合并后统一重算；备注/季节标签做并集
 */
export function mergeInspirations(
  keepId: string,
  mergeIds: string[],
  reason: string | { code: MergeMatchKey; sha256?: string } = 'manual',
): void {
  const db = getDb();
  const match: { code: MergeMatchKey; sha256?: string } =
    typeof reason === 'string' ? { code: 'manual' } : reason;

  const mergeOne = db.transaction((mergeId: string) => {
    if (mergeId === keepId) return;
    const keep = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(keepId) as InspirationRow;
    const dup = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(mergeId) as InspirationRow;
    const ts = nowIso();

    // 1) 标签并集（usage_count：来源卡独有的标签 +1）
    const dupTags = db
      .prepare('SELECT tag_id FROM inspiration_tag WHERE inspiration_id = ?')
      .all(mergeId) as { tag_id: string }[];
    for (const t of dupTags) {
      const res = db
        .prepare(
          `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?, 'bulk', ?)
           ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
        )
        .run(keepId, t.tag_id, ts);
      if (res.changes > 0) db.prepare('UPDATE tag SET usage_count = usage_count + 1 WHERE id = ?').run(t.tag_id);
    }

    // 2) 素材整体改挂（构图标注挂在 asset 上，随之保留）
    db.prepare('UPDATE asset SET inspiration_id = ? WHERE inspiration_id = ?').run(keepId, mergeId);

    // 3) 条件（timing 与灵感一一对应）：能接管就接管，冲突则把来源条件留进 notes
    const keepTiming = db.prepare('SELECT * FROM timing WHERE inspiration_id = ?').get(keepId) as
      | Record<string, unknown>
      | undefined;
    const dupTiming = db.prepare('SELECT * FROM timing WHERE inspiration_id = ?').get(mergeId) as
      | Record<string, unknown>
      | undefined;
    if (dupTiming) {
      if (!keepTiming) {
        db.prepare('UPDATE timing SET inspiration_id = ? WHERE id = ?').run(keepId, dupTiming.id);
      } else {
        const mergedNotes = appendNote(
          (keepTiming.notes as string | null) ?? '',
          `归并自卡片「${dup.title}」：${timingSummary(dupTiming)}`,
        );
        db.prepare('UPDATE timing SET notes = ?, updated_at = ? WHERE inspiration_id = ?').run(
          mergedNotes,
          ts,
          keepId,
        );
        db.prepare('DELETE FROM timing WHERE id = ?').run(dupTiming.id);
      }
    }

    // 4) 窗口历史改挂；同一 (date,start_at) 冲突 → 计划改指向保留窗口，再删除来源窗口
    const dupWindows = db
      .prepare('SELECT id, date, start_at FROM repro_window WHERE inspiration_id = ?')
      .all(mergeId) as { id: string; date: string; start_at: string }[];
    for (const w of dupWindows) {
      const clash = db
        .prepare('SELECT id FROM repro_window WHERE inspiration_id = ? AND date = ? AND start_at = ?')
        .get(keepId, w.date, w.start_at) as { id: string } | undefined;
      if (clash) {
        db.prepare('UPDATE shoot_plan SET window_id = ? WHERE window_id = ?').run(clash.id, w.id);
        db.prepare('DELETE FROM repro_window WHERE id = ?').run(w.id);
      } else {
        db.prepare('UPDATE repro_window SET inspiration_id = ? WHERE id = ?').run(keepId, w.id);
      }
    }

    // 5) 计划 / 回填 / 校准日志 / 分享链接 改挂
    db.prepare('UPDATE shoot_plan SET inspiration_id = ?, updated_at = ? WHERE inspiration_id = ?').run(
      keepId,
      ts,
      mergeId,
    );
    db.prepare('UPDATE shoot_result SET inspiration_id = ? WHERE inspiration_id = ?').run(keepId, mergeId);
    db.prepare('UPDATE calibration_log SET inspiration_id = ? WHERE inspiration_id = ?').run(keepId, mergeId);
    db.prepare("UPDATE share_link SET scope_id = ? WHERE scope = 'inspiration' AND scope_id = ?").run(
      keepId,
      mergeId,
    );

    // 6) 提醒改挂；同一 occurrence_key 冲突时保留优先级更高（更待办）的一条
    const dupReminders = db
      .prepare("SELECT * FROM reminder WHERE subject_type = 'inspiration' AND subject_id = ?")
      .all(mergeId) as Record<string, unknown>[];
    for (const r of dupReminders) {
      const clash = db
        .prepare("SELECT id FROM reminder WHERE subject_type = 'inspiration' AND subject_id = ? AND occurrence_key = ?")
        .get(keepId, r.occurrence_key) as { id: string } | undefined;
      if (clash) {
        const keepR = db.prepare('SELECT * FROM reminder WHERE id = ?').get(clash.id) as Record<string, unknown>;
        const dupWins = reminderPriority(r.status as string) < reminderPriority(keepR.status as string);
        if (dupWins) {
          // 来源提醒更待办：用它的内容覆盖保留卡那条，再删除来源行（id 仍为保留行）
          db.prepare('UPDATE reminder SET status = ?, rule_code = ?, title = ?, body = ?, due_at = ?, expire_at = ?, updated_at = ? WHERE id = ?').run(
            r.status,
            r.rule_code ?? null,
            r.title,
            r.body ?? null,
            r.due_at,
            r.expire_at ?? null,
            ts,
            clash.id,
          );
          db.prepare('DELETE FROM reminder WHERE id = ?').run(r.id);
        } else {
          db.prepare('DELETE FROM reminder WHERE id = ?').run(r.id);
        }
      } else {
        db.prepare("UPDATE reminder SET subject_id = ?, updated_at = ? WHERE id = ?").run(keepId, ts, r.id);
      }
    }

    // 7) 画册成员并集；同画册去重，手动添加与文字说明优先
    const dupItems = db
      .prepare('SELECT * FROM album_item WHERE inspiration_id = ?')
      .all(mergeId) as Record<string, unknown>[];
    for (const item of dupItems) {
      const clash = db
        .prepare('SELECT * FROM album_item WHERE album_id = ? AND inspiration_id = ?')
        .get(item.album_id, keepId) as Record<string, unknown> | undefined;
      if (clash) {
        const caption =
          (clash.caption as string | null) ??
          (item.added_by === 'manual' ? (item.caption as string | null) : null);
        const sortOrder = Math.min(clash.sort_order as number, item.sort_order as number);
        db.prepare('UPDATE album_item SET sort_order = ?, caption = ? WHERE id = ?').run(sortOrder, caption, clash.id);
        db.prepare('DELETE FROM album_item WHERE id = ?').run(item.id);
      } else {
        db.prepare('UPDATE album_item SET inspiration_id = ? WHERE id = ?').run(keepId, item.id);
      }
    }

    // 8) 字段并集：机位 / 备注 / 季节标签 / 发生时间
    const sets: string[] = [];
    const args: unknown[] = [];
    if (!keep.spot_id && dup.spot_id) {
      sets.push('spot_id = ?');
      args.push(dup.spot_id);
    }
    if (dup.note && !keep.note?.includes(dup.note)) {
      sets.push('note = ?');
      args.push(appendNote(keep.note ?? '', `【归并自「${dup.title}」】${dup.note}`));
    }
    const seasons = Array.from(
      new Set([...parseJson<number[]>(keep.season_tags, []), ...parseJson<number[]>(dup.season_tags, [])]),
    ).sort((a, b) => a - b);
    sets.push('season_tags = ?');
    args.push(toJson(seasons));
    if (!occurredAtOf(keep) && occurredAtOf(dup)) {
      sets.push('occurred_at = ?');
      args.push(occurredAtOf(dup));
    }
    db.prepare(`UPDATE inspiration SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]), keepId);

    // 9) 来源卡进终态（不物理删除：历史与审计可追溯），写归并日志
    db.prepare('UPDATE inspiration SET status = ?, archived_reason = ?, updated_at = ? WHERE id = ?').run(
      'dropped',
      `merged:${keepId}`,
      ts,
      mergeId,
    );
    db.prepare(
      `INSERT INTO inspiration_merge_log (id, library_id, keep_id, merged_id, match_key, matched_sha256, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(newId(), keep.library_id, keepId, mergeId, match.code, match.sha256 ?? null, ts);

    reindexFts(mergeId);
  });

  for (const mergeId of mergeIds) mergeOne(mergeId);
  reindexFts(keepId);
  recomputeHitRate(keepId);
  syncStatus(keepId);
}

/** 状态优先级：数字越小越"待办"，归并冲突时保留更需要行动的提醒 */
function reminderPriority(status: string): number {
  return ({ pending: 0, notified: 1, snoozed: 2, done: 3, dismissed: 4, expired: 5 })[status] ?? 6;
}

function appendNote(existing: string, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

function timingSummary(row: Record<string, unknown>): string {
  const parts = [
    `锚点 ${row.time_anchor}${(row.anchor_offset_min as number) ? ` ${(row.anchor_offset_min as number) > 0 ? '+' : ''}${row.anchor_offset_min}分` : ''}`,
  ];
  const az = parseJson<number[] | null>(row.azimuth_range as string, null);
  if (az) parts.push(`方位 ${az[0]}°–${az[1]}°`);
  const profile = parseJson<Record<string, unknown>>(row.weather_profile as string, {});
  if (Object.keys(profile).length) parts.push(`天气画像 ${JSON.stringify(profile)}`);
  if (row.notes) parts.push(`备注：${row.notes}`);
  return parts.join('，');
}

/** InspirationRow（serialization.ts）尚未在所有查询路径带上新列，读取时做一次兜底 */
function occurredAtOf(row: InspirationRow): string | null {
  return row.occurred_at ?? null;
}

/** 维护 FTS 索引（检索用，文档 15.1） */
export function reindexFts(inspirationId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT id, title, note, spot_id FROM inspiration WHERE id = ?').get(inspirationId) as
    | { id: string; title: string; note: string | null; spot_id: string | null }
    | undefined;
  db.prepare('DELETE FROM inspiration_fts WHERE inspiration_id = ?').run(inspirationId);
  if (!row) return;

  let placeText = '';
  if (row.spot_id) {
    const p = db
      .prepare(
        `SELECT pl.name AS place_name, pl.city, pl.district, s.access_note, s.best_time_note
         FROM spot s JOIN place pl ON pl.id = s.place_id WHERE s.id = ?`,
      )
      .get(row.spot_id) as
      | {
          place_name: string;
          city: string | null;
          district: string | null;
          access_note: string | null;
          best_time_note: string | null;
        }
      | undefined;
    if (p) {
      placeText = [p.place_name, p.city, p.district, p.access_note, p.best_time_note].filter(Boolean).join(' ');
    }
  }
  const tags = db
    .prepare(
      'SELECT t.name FROM inspiration_tag it JOIN tag t ON t.id = it.tag_id WHERE it.inspiration_id = ?',
    )
    .all(inspirationId) as { name: string }[];

  db.prepare('INSERT INTO inspiration_fts (inspiration_id, title, note, place, tags) VALUES (?,?,?,?,?)').run(
    inspirationId,
    row.title,
    row.note ?? '',
    placeText,
    tags.map((t) => t.name).join(' '),
  );
}

export function reindexAll(libraryId: string): number {
  const rows = getDb()
    .prepare('SELECT id FROM inspiration WHERE library_id = ? AND deleted_at IS NULL')
    .all(libraryId) as { id: string }[];
  const run = getDb().transaction(() => {
    for (const r of rows) reindexFts(r.id);
  });
  run();
  return rows.length;
}

export function seasonTagsOf(row: InspirationRow): number[] {
  return parseJson<number[]>(row.season_tags, []);
}
