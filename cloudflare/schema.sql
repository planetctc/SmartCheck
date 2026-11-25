CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, secret TEXT NOT NULL, customer TEXT, pc TEXT, os TEXT, version TEXT,
  first_seen TEXT, last_seen TEXT, disks TEXT, worst TEXT, licence TEXT, note TEXT, hidden INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, at TEXT NOT NULL,
  model TEXT, serial TEXT, letters TEXT, text TEXT, ack INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_open ON events(ack, at);
