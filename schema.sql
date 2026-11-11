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

CREATE INDEX IF NOT EXISTS idx_guestbook_ip
  ON guestbook (ip, created_at);

CREATE INDEX IF NOT EXISTS idx_archive_played_at
  ON nowplaying_archive (played_at);

INSERT OR IGNORE INTO site_status (id, mood, status)
VALUES (1, 'dramatic', 'currently living in Windows XP');
