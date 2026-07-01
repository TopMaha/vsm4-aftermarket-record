CREATE TABLE IF NOT EXISTS handover (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  by_id TEXT,
  by_name TEXT,
  ts TEXT NOT NULL,
  edited_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handover_updated ON handover(updated_at);
