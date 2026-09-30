import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Empty, Input, Space, Table, Tag, Typography, Upload, message } from 'antd';
import type { UploadFile } from 'antd';
import type { InspirationDto } from '@flil/shared';
import { useBulkTag, useCreateInspiration, useInboxImport, useInspirations, useTags, useUploadAssets } from '../api/hooks.js';
import { TagPicker } from '../components/TagPicker.js';

/** 收件箱 = 采集闭环的入口：导入归并 → 10 秒打标 → 补条件 */
export default function Inbox() {
  const inbox = useInspirations({ status: 'draft,tagging,timing_missing', size: 50 });
  const { data: tags } = useTags();
  const create = useCreateInspiration();
  const bulkTag = useBulkTag();
  const uploadAssets = useUploadAssets();
  const inboxImport = useInboxImport();

  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [importTitle, setImportTitle] = useState('');
  const [importTagIds, setImportTagIds] = useState<string[]>([]);
  const [importFiles, setImportFiles] = useState<UploadFile[]>([]);

  const items = inbox.data?.items ?? [];

  async function addCard() {
    if (!title.trim()) return;
    try {
      const res = await create.mutateAsync({ title: title.trim() });
      setTitle('');
      message.success('已加入收件箱，先去打标签');
      setSelected([res.id]);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function applyTags() {
    if (!selected.length || !pickedTags.length) return;
    try {
      const res = await bulkTag.mutateAsync({ ids: selected, addTagIds: pickedTags });
      message.success(`已为 ${selected.length} 张卡添加 ${res.added} 个标签`);
      setPickedTags([]);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function runImport() {
    const files = importFiles.map((f) => f.originFileObj).filter((f): f is File => Boolean(f));
    if (!files.length) {
      message.warning('先选择至少一张图片');
      return;
    }
    try {
      const res = await inboxImport.mutateAsync({
        files,
        title: importTitle.trim() || undefined,
        tagIds: importTagIds.length ? importTagIds : undefined,
      });
      if (res.duplicated) {
        message.info({
          content:
            res.matchKey === 'image_fingerprint'
              ? `图片指纹命中：已并入现有卡片，${res.skippedAssetCount} 张重复图片未重复入库`
              : '标题与时间命中：已归并进现有卡片，标签与素材完整保留',
          duration: 6,
        });
      } else {
        message.success(`已加入收件箱（新图 ${res.importedAssetIds.length} 张）`);
      }
      setImportFiles([]);
      setImportTitle('');
      setImportTagIds([]);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="① 导入到收件箱（自动按图片指纹 / 标题+时间归并）">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Upload
              multiple
              accept="image/*"
              fileList={importFiles}
              beforeUpload={() => false}
              onChange={({ fileList }) => setImportFiles(fileList.slice(-20))}
              onRemove={(file) => setImportFiles((prev) => prev.filter((f) => f.uid !== file.uid))}
            >
              <Button>选择图片（可多选）</Button>
            </Upload>
            <Input
              placeholder="标题（留空则取第一张图的文件名）"
              value={importTitle}
              onChange={(e) => setImportTitle(e.target.value)}
              style={{ width: 320 }}
            />
            <Button type="primary" loading={inboxImport.isPending} onClick={runImport}>
              导入
            </Button>
          </Space>
          <TagPicker tree={tags?.items ?? []} value={importTagIds} onChange={setImportTagIds} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            重复导入不会产生新卡片：图片指纹（sha256）相同直接并入；标题相同且拍摄时间相差 90
            分钟内也视为同一条。归并后标签、素材与窗口历史完整保留。
          </Typography.Text>
        </Space>
      </Card>

      <Card title="② 快速收一张无图卡">
        <Space>
          <Input
            placeholder="一句话描述这条灵感，例如：三号楼连廊黄昏逆光"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPressEnter={addCard}
            style={{ width: 420 }}
          />
          <Button type="primary" loading={create.isPending} onClick={addCard}>
            加入收件箱
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            先建卡再补图也完全可以——草稿不会被丢掉，但会一直出现在"待整理"里。
          </Typography.Text>
        </Space>
      </Card>

      <Card
        title={`③ 批量打标（已选 ${selected.length} 张）`}
        extra={
          <Button type="primary" loading={bulkTag.isPending} disabled={!selected.length || !pickedTags.length} onClick={applyTags}>
            应用到已选卡片
          </Button>
        }
      >
        <TagPicker tree={tags?.items ?? []} value={pickedTags} onChange={setPickedTags} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          连拍同一个场景时，一次打标就能铺开一批卡——这是这个库能不能坚持下去的关键。
        </Typography.Text>
      </Card>

      <Card title="④ 待整理清单">
        {items.length === 0 ? (
          <Empty description="收件箱是空的，去现实里找点什么吧" />
        ) : (
          <Table<InspirationDto>
            rowKey="id"
            size="small"
            pagination={false}
            rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
            dataSource={items}
            columns={[
              {
                title: '标题',
                dataIndex: 'title',
                render: (_, row) => <Link to={`/inspirations/${row.id}`}>{row.title}</Link>,
              },
              {
                title: '状态',
                width: 120,
                render: (_, row) => (
                  <Tag color={row.status === 'timing_missing' ? 'orange' : row.status === 'tagging' ? 'blue' : 'default'}>
                    {row.status === 'timing_missing' ? '缺条件' : row.status === 'tagging' ? '缺标签' : '草稿'}
                  </Tag>
                ),
              },
              {
                title: '标签',
                render: (_, row) =>
                  row.tags.length ? (
                    <Space wrap size={[4, 4]}>
                      {row.tags.slice(0, 5).map((t) => (
                        <Tag key={t.id}>{t.name}</Tag>
                      ))}
                      {row.tags.length > 5 ? <Tag>+{row.tags.length - 5}</Tag> : null}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">未打标</Typography.Text>
                  ),
              },
              {
                title: '图片',
                width: 110,
                render: (_, row) => (
                  <Upload
                    showUploadList={false}
                    multiple
                    accept="image/*"
                    beforeUpload={() => true}
                    customRequest={async ({ file, onSuccess, onError }) => {
                      setUploadingFor(row.id);
                      try {
                        const res = await uploadAssets.mutateAsync({
                          id: row.id,
                          files: [file as File],
                          role: 'reference',
                        });
                        const gps = res.items.some((i) => i.hasGpsExif);
                        message.success(gps ? '上传成功（原图含 GPS，已按隐私策略不入库）' : '上传成功');
                        onSuccess?.(res);
                      } catch (err) {
                        message.error((err as Error).message);
                        onError?.(err as Error);
                      } finally {
                        setUploadingFor(null);
                      }
                    }}
                  >
                    <Button size="small" loading={uploadingFor === row.id}>
                      {row.assets.length ? `再加图（${row.assets.length}）` : '上传'}
                    </Button>
                  </Upload>
                ),
              },
              {
                title: '操作',
                width: 90,
                render: (_, row) => (
                  <Link to={`/inspirations/${row.id}`}>
                    <Button size="small">整理</Button>
                  </Link>
                ),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}
