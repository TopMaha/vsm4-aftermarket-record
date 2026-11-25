CREATE TABLE IF NOT EXISTS handover (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  cat TEXT NOT NULL DEFAULT 'note',   -- broken=เครื่องเสีย/ค้าง · note=ข้อมูลทั่วไป (แบ่ง 3 คอลัมน์ฝั่ง UI)
  text TEXT NOT NULL,
  by_id TEXT,
  by_name TEXT,
  ts TEXT NOT NULL,
  edited_at TEXT,
  task INTEGER NOT NULL DEFAULT 0,     -- "ข้อ checklist" (v3.7): สร้างจาก builder เท่านั้น — โน้ตเก่า=0 ไม่มี checkbox
  done INTEGER NOT NULL DEFAULT 0,     -- สถานะติ๊กของข้อ checklist: กะถัดไปติ๊กเมื่อทำแล้ว
  done_by TEXT,                        -- รหัสคนติ๊ก
  done_by_name TEXT,                   -- ชื่อคนติ๊ก
  done_at TEXT,                        -- เวลา ISO ที่ติ๊ก
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handover_updated ON handover(updated_at);
-- ตารางที่มีอยู่แล้ว (deploy ก่อนหน้า) ให้เพิ่มคอลัมน์ด้วย (มีแล้วจะ error → ข้ามได้):
-- ALTER TABLE handover ADD COLUMN cat TEXT NOT NULL DEFAULT 'note';
-- ALTER TABLE handover ADD COLUMN task INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE handover ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE handover ADD COLUMN done_by TEXT;
-- ALTER TABLE handover ADD COLUMN done_by_name TEXT;
-- ALTER TABLE handover ADD COLUMN done_at TEXT;

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

-- ============================================================
-- ★ v4.34 เอกสารทั่วไป (qi = งานเฝ้าระวังคุณภาพ · hosign = ลงชื่อรับทราบต่อกะ) + รูปแนบ
-- endpoints: /doc/list|put|bulk · /img/put · /img/<id>  (Worker สร้างตารางเองตอนเรียกครั้งแรก)
-- ============================================================
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  vsm TEXT,
  data TEXT NOT NULL,                  -- JSON เนื้อหา
  by_id TEXT,
  by_name TEXT,
  ts TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,  -- soft delete
  updated_at TEXT NOT NULL,            -- LWW (เวลาเครื่องผู้ใช้)
  seen_at TEXT NOT NULL                -- เวลาที่ Worker รับ (ใช้กับ ?since=)
);
CREATE INDEX IF NOT EXISTS idx_docs_kind_seen ON docs(kind, seen_at);
CREATE TABLE IF NOT EXISTS imgs (
  id TEXT PRIMARY KEY,
  ref TEXT,                            -- id ของเอกสารที่รูปนี้แนบ
  mime TEXT NOT NULL,
  data TEXT NOT NULL,                  -- base64
  size INTEGER NOT NULL DEFAULT 0,
  by_id TEXT,
  ts TEXT NOT NULL
);
