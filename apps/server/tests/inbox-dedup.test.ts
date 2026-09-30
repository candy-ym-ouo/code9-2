import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import sharp from 'sharp';

/**
 * 收件箱归并（按标题、时间和图片指纹）：
 *  - 重复导入不新增记录（卡片与素材都幂等）；
 *  - 合并后标签、素材与窗口历史完整保留。
 */

let app: Express;
let token = '';
let tmpDir = '';

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

/** 生成内容确定的小图（不同颜色 → 不同指纹） */
function pngOf(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: color } })
    .png()
    .toBuffer();
}

function importReq(fields: Record<string, string>, files: { name: string; buf: Buffer }[]) {
  let req = request(app)
    .post('/api/inspirations/import')
    .set('authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  for (const f of files) req = req.attach('files', f.buf, f.name);
  return req;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-inbox-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const res = await call('post', '/api/auth/register', {
    email: 'inbox@test.local',
    password: 'password123',
    displayName: '收件箱测试',
  });
  expect(res.status).toBe(201);
  token = res.body.token;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('收件箱归并：标题 + 时间', () => {
  it('同标题当天重复创建 → 返回既有卡，不新增记录', async () => {
    const first = await call('post', '/api/inspirations', { title: '三号楼连廊黄昏逆光' });
    expect(first.status).toBe(201);
    expect(first.body.deduplicated).toBe(false);

    const again = await call('post', '/api/inspirations', { title: '  三号楼连廊黄昏逆光 ' });
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.matchedBy).toBe('title_time');
    expect(again.body.id).toBe(first.body.id);

    const list = await call('get', '/api/inspirations');
    expect(list.body.total).toBe(1);
  });

  it('终态卡不参与归并（已归档的同标题卡允许重建）', async () => {
    const created = await call('post', '/api/inspirations', { title: '已归档的旧灵感' });
    await call('post', `/api/inspirations/${created.body.id}/archive`, { reason: '拍过了' });

    const rebuilt = await call('post', '/api/inspirations', { title: '已归档的旧灵感' });
    expect(rebuilt.status).toBe(201);
    expect(rebuilt.body.id).not.toBe(created.body.id);
  });
});

describe('收件箱归并：图片指纹', () => {
  it('同一批图重复导入 → 不新增卡也不新增素材', async () => {
    const imgA = await pngOf({ r: 200, g: 40, b: 40 });
    const imgB = await pngOf({ r: 40, g: 200, b: 40 });

    const first = await importReq({ title: '天台金色时刻' }, [
      { name: 'a.png', buf: imgA },
      { name: 'b.png', buf: imgB },
    ]);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.addedAssets).toBe(2);

    const again = await importReq({ title: '天台金色时刻' }, [
      { name: 'a.png', buf: imgA },
      { name: 'b.png', buf: imgB },
    ]);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.addedAssets).toBe(0);
    expect(again.body.skippedDuplicates).toBe(2);

    const detail = await call('get', `/api/inspirations/${first.body.id}`);
    expect(detail.body.item.assets).toHaveLength(2);
  });

  it('标题不同但图片指纹相同 → 归并到持有该图的既有卡', async () => {
    const img = await pngOf({ r: 40, g: 40, b: 200 });
    const first = await importReq({ title: '蓝墙晨光' }, [{ name: 'c.png', buf: img }]);
    expect(first.status).toBe(201);

    const other = await importReq({ title: '完全不一样的标题' }, [{ name: 'c.png', buf: img }]);
    expect(other.status).toBe(200);
    expect(other.body.created).toBe(false);
    expect(other.body.matchedBy).toBe('fingerprint');
    expect(other.body.id).toBe(first.body.id);
    expect(other.body.skippedDuplicates).toBe(1);

    const list = await call('get', '/api/inspirations?status=draft,tagging,timing_missing');
    const titles = list.body.items.map((i: { title: string }) => i.title);
    expect(titles).not.toContain('完全不一样的标题');
  });

  it('向同一张卡重复上传同一文件 → 不新增素材行', async () => {
    const img = await pngOf({ r: 120, g: 120, b: 30 });
    const card = await call('post', '/api/inspirations', { title: '重复上传测试' });

    const up1 = await request(app)
      .post(`/api/inspirations/${card.body.id}/assets`)
      .set('authorization', `Bearer ${token}`)
      .attach('files', img, 'dup.png');
    expect(up1.status).toBe(201);

    const up2 = await request(app)
      .post(`/api/inspirations/${card.body.id}/assets`)
      .set('authorization', `Bearer ${token}`)
      .attach('files', img, 'dup.png');
    expect(up2.status).toBe(201);
    expect(up2.body.items[0].assetId).toBe(up1.body.items[0].assetId);
    expect(up2.body.items[0].duplicateOf).toBe(up1.body.items[0].assetId);

    const detail = await call('get', `/api/inspirations/${card.body.id}`);
    expect(detail.body.item.assets).toHaveLength(1);
  });
});

describe('合并：标签、素材与窗口历史完整保留', () => {
  it('merge 后 keep 卡拥有双方标签、素材与全部窗口，计划引用不悬空', async () => {
    // 两张卡共用机位，但时间锚不同 → 各自的 7 天窗口 start_at 不同
    const place = await call('post', '/api/places', { name: '归并测试地点', city: '上海' });
    const spot = await call('post', '/api/spots', {
      placeId: place.body.id,
      lat: 31.24,
      lng: 121.44,
      cameraBearing: 250,
    });

    const mkCard = async (title: string, offset: number) => {
      const created = await call('post', '/api/inspirations', { title });
      const id = created.body.id as string;
      await call('post', `/api/inspirations/${id}/spot`, { spotId: spot.body.id });
      const timing = await call('put', `/api/inspirations/${id}/timing`, {
        timeAnchor: 'sunset_minus',
        anchorOffsetMin: offset,
        elevationRange: [-90, 90],
        azimuthRange: null,
        azimuthTolerance: 15,
        windowToleranceMin: 12,
        weatherProfile: {},
        seasonWindow: null,
        notes: null,
      });
      expect(timing.status).toBe(200);
      const windows = await call('post', `/api/inspirations/${id}/windows/recompute`, { days: 7 });
      expect(windows.status).toBe(200);
      return { id, windowIds: windows.body.items.map((w: { id: string }) => w.id) };
    };

    const keep = await mkCard('归并-保留卡', 40);
    const drop = await mkCard('归并-被并卡', 75);
    expect(keep.windowIds).toHaveLength(7);
    expect(drop.windowIds).toHaveLength(7);

    // 双方各带标签；被并卡带一张素材和一个出行计划
    const tags = await call('get', '/api/tags');
    const flat = (tags.body.items as { children?: { id: string; name: string }[] }[]).flatMap(
      (g) => g.children ?? [],
    );
    const tagA = flat[0].id;
    const tagB = flat[1].id;
    await call('post', '/api/inspirations/bulk-tag', { ids: [keep.id], addTagIds: [tagA] });
    await call('post', '/api/inspirations/bulk-tag', { ids: [drop.id], addTagIds: [tagB] });

    const img = await pngOf({ r: 10, g: 90, b: 160 });
    const up = await request(app)
      .post(`/api/inspirations/${drop.id}/assets`)
      .set('authorization', `Bearer ${token}`)
      .attach('files', img, 'drop.png');
    expect(up.status).toBe(201);

    const plan = await call('post', '/api/plans', { windowId: drop.windowIds[0], commuteMin: 20 });
    expect(plan.status).toBe(201);

    const merge = await call('post', '/api/inspirations/merge', {
      keepId: keep.id,
      mergeIds: [drop.id],
      reason: '同一场景重复建卡',
    });
    expect(merge.status).toBe(200);
    expect(merge.body.merged).toBe(1);
    expect(merge.body.movedAssets).toBe(1);
    expect(merge.body.movedWindows).toBe(7);

    // 标签与素材并入 keep
    const detail = await call('get', `/api/inspirations/${keep.id}`);
    const tagIds = detail.body.item.tags.map((t: { id: string }) => t.id);
    expect(tagIds).toEqual(expect.arrayContaining([tagA, tagB]));
    expect(detail.body.item.assets).toHaveLength(1);

    // 窗口历史完整：keep 原有 7 条 + 并入 7 条，被并卡的窗口 id 全部保留
    const windows = await call('get', `/api/inspirations/${keep.id}/windows?days=7`);
    expect(windows.body.items).toHaveLength(14);
    const keptWindowIds = windows.body.items.map((w: { id: string }) => w.id);
    for (const wid of [...keep.windowIds, ...drop.windowIds]) {
      expect(keptWindowIds).toContain(wid);
    }

    // 计划仍指向同一窗口（该窗口现在属于 keep 卡）
    const plans = await call('get', '/api/plans');
    const kept = plans.body.items.find((p: { id: string }) => p.id === plan.body.id);
    expect(kept.windowId).toBe(drop.windowIds[0]);

    // 被并卡进入终态
    const dropped = await call('get', `/api/inspirations/${drop.id}`);
    expect(dropped.body.item.status).toBe('dropped');
  });

  it('同时段窗口冲突时去重，计划引用改指到保留卡的窗口', async () => {
    const place = await call('post', '/api/places', { name: '冲突窗口地点', city: '上海' });
    const spot = await call('post', '/api/spots', {
      placeId: place.body.id,
      lat: 31.3,
      lng: 121.5,
      cameraBearing: 180,
    });
    const mkCard = async (title: string) => {
      const created = await call('post', '/api/inspirations', { title });
      const id = created.body.id as string;
      await call('post', `/api/inspirations/${id}/spot`, { spotId: spot.body.id });
      await call('put', `/api/inspirations/${id}/timing`, {
        timeAnchor: 'sunrise',
        anchorOffsetMin: 0,
        elevationRange: [-90, 90],
        azimuthRange: null,
        azimuthTolerance: 15,
        windowToleranceMin: 12,
        weatherProfile: {},
        seasonWindow: null,
        notes: null,
      });
      const windows = await call('post', `/api/inspirations/${id}/windows/recompute`, { days: 7 });
      return { id, windowIds: windows.body.items.map((w: { id: string }) => w.id) };
    };

    // 相同机位 + 相同条件 → 两卡窗口 (date, start_at) 完全重叠
    const keep = await mkCard('冲突-保留');
    const drop = await mkCard('冲突-被并');
    const plan = await call('post', '/api/plans', { windowId: drop.windowIds[0], commuteMin: 10 });
    expect(plan.status).toBe(201);

    const merge = await call('post', '/api/inspirations/merge', {
      keepId: keep.id,
      mergeIds: [drop.id],
    });
    expect(merge.status).toBe(200);
    expect(merge.body.movedWindows).toBe(0); // 全部冲突 → 不产生重复时段

    const windows = await call('get', `/api/inspirations/${keep.id}/windows?days=7`);
    expect(windows.body.items).toHaveLength(7);

    // 计划引用被改指到保留卡的等价窗口，不悬空
    const plans = await call('get', '/api/plans');
    const kept = plans.body.items.find((p: { id: string }) => p.id === plan.body.id);
    expect(kept.windowId).toBe(keep.windowIds[0]);
  });
});
