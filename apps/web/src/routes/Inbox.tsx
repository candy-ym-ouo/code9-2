import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Empty, Input, Space, Table, Tag, Typography, Upload, message } from 'antd';
import type { InspirationDto } from '@flil/shared';
import { useBulkTag, useImportInspiration, useInspirations, useTags, useUploadAssets } from '../api/hooks.js';
import { TagPicker } from '../components/TagPicker.js';

/** 收件箱 = 采集闭环的入口：导入（自动归并）→ 10 秒打标 → 补条件 */
export default function Inbox() {
  const inbox = useInspirations({ status: 'draft,tagging,timing_missing', size: 50 });
  const { data: tags } = useTags();
  const importInspiration = useImportInspiration();
  const bulkTag = useBulkTag();
  const uploadAssets = useUploadAssets();

  const [title, setTitle] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);

  const items = inbox.data?.items ?? [];

  async function addCard() {
    if (!title.trim()) return;
    try {
      // 服务端按 标题+时间 / 图片指纹 归并：重复导入不会新增记录
      const res = await importInspiration.mutateAsync({ title: title.trim(), files: pendingFiles });
      setTitle('');
      setPendingFiles([]);
      if (res.created) {
        message.success('已加入收件箱，先去打标签');
      } else {
        const skipped = res.skippedDuplicates > 0 ? `，跳过 ${res.skippedDuplicates} 张重复图片` : '';
        message.info(`已归并到既有卡片（${res.matchedBy === 'fingerprint' ? '图片指纹相同' : '同标题'}）${skipped}`);
      }
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="① 快速收一张卡">
        <Space wrap>
          <Input
            placeholder="一句话描述这条灵感，例如：三号楼连廊黄昏逆光"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onPressEnter={addCard}
            style={{ width: 420 }}
          />
          <Upload
            multiple
            accept="image/*"
            fileList={pendingFiles.map((f, i) => ({ uid: String(i), name: f.name }))}
            beforeUpload={(file) => {
              setPendingFiles((prev) => [...prev, file as File]);
              return false;
            }}
            onRemove={(file) => {
              setPendingFiles((prev) => prev.filter((_, i) => String(i) !== file.uid));
            }}
          >
            <Button>选图（可多选）</Button>
          </Upload>
          <Button type="primary" loading={importInspiration.isPending} onClick={addCard}>
            加入收件箱
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            同标题或同一张图会自动归并到既有卡片，重复导入不会新增记录；草稿不会被丢掉，但会一直出现在"待整理"里。
          </Typography.Text>
        </Space>
      </Card>

      <Card
        title={`② 批量打标（已选 ${selected.length} 张）`}
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

      <Card title="③ 待整理清单">
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
