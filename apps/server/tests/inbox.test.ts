import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

// 用一张 1x1 PNG 与它的字节变体（追加尾部字节 → 指纹不同）做指纹归并测试
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

let app: Express;
let token = '';
let tmpDir = '';
let tagId = '';

function call(method: 'get' | 'post', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
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

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'inbox@test.local', password: 'password123', displayName: '收件箱测试' });
  token = reg.body.token;
  const tags = await call('get', '/api/tags');
  tagId = (tags.body.items as { children?: { id: string; name: string }[] }[])
    .flatMap((g) => g.children ?? [])
    .find((t) => t.name === '逆光')!.id;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function inboxImport(opts: {
  bytes: Buffer;
  filename: string;
  title?: string;
  occurredAt?: string;
  tagIds?: string;
}) {
  let req = request(app)
    .post('/api/inbox/import')
    .set('authorization', `Bearer ${token}`)
    .attach('files', opts.bytes, { filename: opts.filename, contentType: 'image/png' });
  if (opts.title) req = req.field('title', opts.title);
  if (opts.occurredAt) req = req.field('occurredAt', opts.occurredAt);
  if (opts.tagIds) req = req.field('tagIds', opts.tagIds);
  return req;
}

describe('收件箱导入：指纹归并', () => {
  it('首次导入新建卡片', async () => {
    const res = await inboxImport({ bytes: PNG_1X1, filename: 'corridor-a.png', title: '连廊黄昏', tagIds: tagId });
    expect(res.status).toBe(201);
    expect(res.body.duplicated).toBe(false);
    expect(res.body.importedAssetIds).toHaveLength(1);

    const list = await call('get', '/api/inspirations');
    expect(list.body.total).toBe(1);
  });

  it('同一张图再导一次：不新增卡片、不重复落素材（200 + image_fingerprint）', async () => {
    const before = await call('get', '/api/inspirations');
    const res = await inboxImport({ bytes: PNG_1X1, filename: 'corridor-copy.png', title: '完全不同的标题也没用' });
    expect(res.status).toBe(200);
    expect(res.body.duplicated).toBe(true);
    expect(res.body.matchKey).toBe('image_fingerprint');
    expect(res.body.assetSkipped).toBe(true);
    expect(res.body.skippedAssetCount).toBe(1);

    const after = await call('get', '/api/inspirations');
    expect(after.body.total).toBe(before.body.total);

    const detail = await call('get', `/api/inspirations/${res.body.inspirationId}`);
    expect(detail.body.item.assets).toHaveLength(1);
    expect(detail.body.item.tags.some((t: { id: string }) => t.id === tagId)).toBe(true);
  });

  it('probe 不写数据也能预报指纹命中', async () => {
    const crypto = await import('node:crypto');
    const sha256 = crypto.createHash('sha256').update(PNG_1X1).digest('hex');
    const res = await call('post', '/api/inbox/probe', { title: '随便', sha256 });
    expect(res.body.duplicated).toBe(true);
    expect(res.body.match.matchKey).toBe('image_fingerprint');
  });
});

describe('收件箱导入：标题+时间归并', () => {
  const occurredAt = '2026-03-21T10:00:00.000Z';

  it('新标题 + 拍摄时间 → 新建', async () => {
    const bytes = Buffer.concat([PNG_1X1, Buffer.from([1, 2, 3])]);
    const res = await inboxImport({ bytes, filename: 'roof-1.png', title: '天台蓝调', occurredAt });
    expect(res.status).toBe(201);
  });

  it('标题标点/空白不同 + 时间相隔 30 分钟 → 归并，不新增卡片；标签与图片并入', async () => {
    const before = await call('get', '/api/inspirations');
    const bytes = Buffer.concat([PNG_1X1, Buffer.from([4, 5, 6])]);
    const res = await inboxImport({
      bytes,
      filename: 'roof-2.png',
      title: ' 天台  蓝调！',
      occurredAt: '2026-03-21T10:30:00.000Z',
      tagIds: tagId,
    });
    expect(res.status).toBe(200);
    expect(res.body.duplicated).toBe(true);
    expect(res.body.matchKey).toBe('title_time');
    expect(res.body.importedAssetIds).toHaveLength(1);

    const after = await call('get', '/api/inspirations');
    expect(after.body.total).toBe(before.body.total);

    const detail = await call('get', `/api/inspirations/${res.body.inspirationId}`);
    expect(detail.body.item.assets).toHaveLength(2);
    expect(detail.body.item.tags.some((t: { id: string }) => t.id === tagId)).toBe(true);
  });

  it('时间相隔超过 90 分钟 → 不算重复，新建卡片', async () => {
    const bytes = Buffer.concat([PNG_1X1, Buffer.from([7, 8, 9])]);
    const res = await inboxImport({
      bytes,
      filename: 'roof-3.png',
      title: '天台蓝调',
      occurredAt: '2026-03-21T13:00:00.000Z',
    });
    expect(res.status).toBe(201);
    expect(res.body.duplicated).toBe(false);
  });

  it('只有标题相同、没有拍摄时间 → 不做时间归并，新建卡片', async () => {
    const bytes = Buffer.concat([PNG_1X1, Buffer.from([10, 11, 12])]);
    const res = await inboxImport({ bytes, filename: 'roof-4.png', title: '天台蓝调' });
    expect(res.status).toBe(201);
  });
});

describe('归并：标签、素材与窗口历史完整保留', () => {
  it('窗口、条件、计划、回填在手动合并后全部挂到保留卡', async () => {
    // A 卡：条件 + 窗口
    const a = await call('post', '/api/inspirations', { title: '手动合并A' });
    const place = await call('post', '/api/places', { name: '合并测试地点', city: '上海' });
    const spot = await call('post', '/api/spots', { placeId: place.body.id, lat: 31.2, lng: 121.4, cameraBearing: 90 });
    await call('post', `/api/inspirations/${a.body.id}/spot`, { spotId: spot.body.id });
    await call('put', `/api/inspirations/${a.body.id}/timing`, {
      timeAnchor: 'sunset_minus',
      anchorOffsetMin: 40,
      elevationRange: [-4, 10],
      azimuthRange: null,
      azimuthTolerance: 15,
      windowToleranceMin: 12,
      weatherProfile: {},
      seasonWindow: null,
      notes: null,
    });
    const windows = await call('post', `/api/inspirations/${a.body.id}/windows/recompute`, { days: 7 });
    expect(windows.body.items.length).toBeGreaterThan(0);
    const windowId = windows.body.items[0].id;
    await call('post', '/api/inspirations/bulk-tag', { ids: [a.body.id], addTagIds: [tagId] });
    const plan = await call('post', '/api/plans', { windowId, commuteMin: 25 });
    await call('post', `/api/plans/${plan.body.id}/result`, {
      hitLevel: 'hit',
      missReasons: [],
    });

    // B 卡：另一张图 + 标签
    const b = await inboxImport({
      bytes: Buffer.concat([PNG_1X1, Buffer.from([20, 21])]),
      filename: 'merge-b.png',
      title: '手动合并B',
    });
    const bId = b.body.inspirationId;

    // 手动合并 B → A
    const merged = await call('post', '/api/inspirations/merge', { keepId: a.body.id, mergeIds: [bId] });
    expect(merged.status).toBe(200);

    const detail = await call('get', `/api/inspirations/${a.body.id}`);
    expect(detail.body.item.assets.length).toBeGreaterThanOrEqual(1); // B 的图并过来了
    expect(detail.body.item.tags.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.item.timing).toBeTruthy(); // 条件保留
    expect(detail.body.item.hitCount).toBe(1); // 回填统计保留

    // 窗口历史保留
    const wins = await call('get', `/api/inspirations/${a.body.id}/windows?days=7`);
    expect(wins.body.items.length).toBeGreaterThan(0);

    // 计划仍在、且挂在 A 下
    const plans = await call('get', '/api/plans');
    const planOnA = plans.body.items.find((p: { id: string }) => p.id === plan.body.id);
    expect(planOnA.inspirationId).toBe(a.body.id);
    expect(planOnA.result).toBeTruthy();

    // 归并审计
    const history = await call('get', `/api/inspirations/${a.body.id}/merge-history`);
    expect(history.body.items[0].mergedId).toBe(bId);
    expect(history.body.items[0].matchKey).toBe('manual');
  });
});
