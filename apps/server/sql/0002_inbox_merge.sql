-- 收件箱归并（文档：灵感收件箱按标题、时间和图片指纹归并）
-- 1) 归并键：归一化标题 + 发生时间；图片指纹走 asset.sha256
ALTER TABLE inspiration ADD COLUMN title_key TEXT;
ALTER TABLE inspiration ADD COLUMN occurred_at TEXT;

-- 标题归并走归一化后的稳定键（同库内比较），时间归并按发生时间容差比较，
-- 因此只对 (library_id, title_key) 建普通索引，时间在查询里做范围条件。
CREATE INDEX IF NOT EXISTS idx_insp_library_titlekey
  ON inspiration(library_id, title_key);

-- 2) 归并审计：谁被并进谁、按哪条键命中，保证"合并且可追溯"
CREATE TABLE IF NOT EXISTS inspiration_merge_log (
  id               TEXT PRIMARY KEY,
  library_id       TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  keep_id          TEXT NOT NULL,
  merged_id        TEXT NOT NULL,
  match_key        TEXT NOT NULL CHECK (match_key IN ('image_fingerprint','title_time','manual','reimport')),
  matched_sha256   TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merge_log_keep ON inspiration_merge_log(keep_id, created_at DESC);
