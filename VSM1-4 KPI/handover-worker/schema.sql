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

-- ============================================================
-- WIP IN 1.5 — งานที่รับเข้าจาก VSM2 มารอผลิตที่ Process แรก (ข้ามเครื่อง)
-- แยกตารางจาก handover เพื่อไม่ปน list ต่อกะ · endpoints: /wipin/list|put|bulk
-- ============================================================
CREATE TABLE IF NOT EXISTS wipin (
  id TEXT PRIMARY KEY,
  vsm TEXT,                            -- vsm1..vsm4 (ประทับจากผู้บันทึก)
  valve TEXT NOT NULL,                 -- Valve No
  lot TEXT,                            -- LOT
  qty INTEGER NOT NULL DEFAULT 0,      -- Q'ty ที่รับเข้า
  by_id TEXT,
  by_name TEXT,
  ts TEXT NOT NULL,                    -- เวลาที่รับเข้า (ISO)
  deleted INTEGER NOT NULL DEFAULT 0,  -- soft delete (กัน entry ฟื้นจาก race)
  updated_at TEXT NOT NULL             -- LWW
);
CREATE INDEX IF NOT EXISTS idx_wipin_updated ON wipin(updated_at);
