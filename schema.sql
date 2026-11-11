-- worker.js creates anything missing here automatically when it starts,
-- so this file is a reference for the database layout rather than a
-- required setup step.

CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  ip TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_status (
  id INTEGER PRIMARY KEY,
  mood TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nowplaying_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_name TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_art TEXT,
  track_url TEXT,
  played_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One row: the current Discord status and when it last flipped between
-- online and offline.
CREATE TABLE IF NOT EXISTS discord_presence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  since TEXT NOT NULL,
  last_online_at TEXT,
  checked_at TEXT NOT NULL,
  payload TEXT
);

-- Small key/value store (archive sync progress)
CREATE TABLE IF NOT EXISTS site_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guestbook_ip
  ON guestbook (ip, created_at);

CREATE INDEX IF NOT EXISTS idx_archive_played_at
  ON nowplaying_archive (played_at);

INSERT OR IGNORE INTO site_status (id, mood, status)
VALUES (1, 'dramatic', 'currently living in Windows XP');
