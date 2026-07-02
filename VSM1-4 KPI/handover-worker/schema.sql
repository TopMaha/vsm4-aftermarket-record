CREATE TABLE IF NOT EXISTS handover (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  cat TEXT NOT NULL DEFAULT 'note',   -- broken=เครื่องเสีย/ค้าง · note=ข้อมูลทั่วไป (แบ่ง 3 คอลัมน์ฝั่ง UI)
  text TEXT NOT NULL,
  by_id TEXT,
  by_name TEXT,
  ts TEXT NOT NULL,
  edited_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handover_updated ON handover(updated_at);
-- ตารางที่มีอยู่แล้ว (deploy ก่อนหน้า) ให้เพิ่มคอลัมน์ด้วย (มีแล้วจะ error → ข้ามได้):
-- ALTER TABLE handover ADD COLUMN cat TEXT NOT NULL DEFAULT 'note';
