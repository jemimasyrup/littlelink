const LASTFM_KEY = "be3c5d62a114a966685354a725e8738e";
const LASTFM_USER = "hp173011";
const DISCORD_ID = "783776027846639688";

// gemini-2.0-flash has been retired by Google. Override with a GEMINI_MODEL
// variable in the Cloudflare dashboard / wrangler.toml if this one is retired too.
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

const MOOD_CACHE_SECONDS = 600;
const GUESTBOOK_COOLDOWN_SECONDS = 30;

// How fresh the stored Discord presence must be before we ask Lanyard again
const PRESENCE_MAX_AGE_SECONDS = 45;

// How far back the music archive is filled in from Last.fm, and how many
// pages (200 plays each) are fetched per run while catching up
const ARCHIVE_BACKFILL_DAYS = 90;
const ARCHIVE_BACKFILL_PAGES_PER_RUN = 3;
const ARCHIVE_PAGE_SIZE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

// D1's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC with no timezone
// marker, which browsers read as local time (or not at all). Make it ISO.
function toISO(timestamp) {
  if (!timestamp) return null;
  if (timestamp.includes("T")) return timestamp;
  return timestamp.replace(" ", "T") + "Z";
}

/* ------------------------------------------------------------------ */
/* Database setup                                                      */
/* ------------------------------------------------------------------ */

// Creates anything that's missing, so new features work without having to
// run schema.sql by hand. Runs once each time the worker starts up.
let schemaReady = null;

function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = setUpSchema(env).catch(error => {
      schemaReady = null;
      throw error;
    });
  }

  return schemaReady;
}

async function setUpSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS guestbook (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        ip TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS nowplaying_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_name TEXT NOT NULL,
        artist TEXT NOT NULL,
        album_art TEXT,
        track_url TEXT,
        played_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_archive_played_at
      ON nowplaying_archive (played_at)
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS discord_presence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        since TEXT NOT NULL,
        last_online_at TEXT,
        checked_at TEXT NOT NULL,
        payload TEXT
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS site_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  ]);

  // Older databases were created before the guestbook stored an IP address
  try {
    await env.DB.prepare("ALTER TABLE guestbook ADD COLUMN ip TEXT").run();
  } catch {
    // The column is already there
  }
}

async function getState(env, key) {
  const row = await env.DB.prepare(
    "SELECT value FROM site_state WHERE key = ?"
  ).bind(key).first();

  if (!row) return null;

  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function setState(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO site_state (key, value) VALUES (?1, ?2)
    ON CONFLICT (key) DO UPDATE SET value = ?2
  `).bind(key, JSON.stringify(value)).run();
}

/* ------------------------------------------------------------------ */
/* Guestbook                                                           */
/* ------------------------------------------------------------------ */

async function getGuestbook(env) {
  const messages = await env.DB.prepare(
    "SELECT name, message, created_at FROM guestbook ORDER BY id DESC LIMIT 25"
  ).all();

  return json(
    messages.results.map(row => ({
      ...row,
      created_at: toISO(row.created_at)
    }))
  );
}

async function postGuestbook(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  if (!body || typeof body !== "object") {
    return json({ error: "Invalid request" }, 400);
  }

  // Honeypot field - real visitors never fill this in
  if (body.website) {
    return json({ success: true });
  }

  const name = String(body.name || "").trim().slice(0, 24);
  const message = String(body.message || "").trim().slice(0, 180);

  if (!name || !message) {
    return json({ error: "Name and message required" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const recent = await env.DB.prepare(
    "SELECT id FROM guestbook WHERE ip = ? AND created_at > datetime('now', ?) LIMIT 1"
  ).bind(ip, `-${GUESTBOOK_COOLDOWN_SECONDS} seconds`).first();

  if (recent) {
    return json(
      { error: "Slow down! Wait a moment before signing again." },
      429,
      { "Retry-After": String(GUESTBOOK_COOLDOWN_SECONDS) }
    );
  }

  await env.DB.prepare(
    "INSERT INTO guestbook (name, message, ip) VALUES (?, ?, ?)"
  ).bind(name, message, ip).run();

  return json({ success: true });
}

/* ------------------------------------------------------------------ */
/* Last.fm                                                             */
/* ------------------------------------------------------------------ */

async function fetchRecentTracks({ limit = 5, page = 1, from, to } = {}) {
  const params = new URLSearchParams({
    method: "user.getrecenttracks",
    user: LASTFM_USER,
    api_key: LASTFM_KEY,
    format: "json",
    limit: String(limit),
    page: String(page)
  });

  if (from) params.set("from", String(from));
  if (to) params.set("to", String(to));

  const response = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);

  if (!response.ok) {
    throw new Error(`Last.fm responded with ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  }

  const tracks = data.recenttracks?.track || [];

  return {
    // Last.fm returns a bare object instead of an array when there is one track
    tracks: Array.isArray(tracks) ? tracks : [tracks],
    totalPages: Number(data.recenttracks?.["@attr"]?.totalPages) || 1
  };
}

/* ------------------------------------------------------------------ */
/* Mood                                                                */
/* ------------------------------------------------------------------ */

async function getMood(request, env, ctx) {
  // Cache the answer so every page view doesn't spend Gemini quota
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/mood", request.url).toString());

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    if (!env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set");
    }

    const { tracks } = await fetchRecentTracks({ limit: 5 });

    const songs = tracks
      .map(track => `${track.name} by ${track.artist?.["#text"] || "unknown"}`)
      .join(", ");

    if (!songs) {
      return json({ mood: "suspiciously silent" });
    }

    const prompt = `
Based on these recently played songs:

${songs}

Describe the user's mood in ONE short sentence.
Make it dramatic, funny, internet-y and stylish.
No quotation marks.
`;

    const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

    const gemini = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const geminiData = await gemini.json();

    if (!gemini.ok) {
      throw new Error(geminiData?.error?.message || `Gemini responded with ${gemini.status}`);
    }

    const mood = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!mood) {
      return json({ mood: "too mysterious to analyse" });
    }

    const response = json({ mood }, 200, {
      "Cache-Control": `public, max-age=${MOOD_CACHE_SECONDS}`
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (error) {
    // Log the real reason for `wrangler tail`, but don't show it to visitors
    console.error("Mood failed:", error);
    return json({ mood: "emotionally unavailable" });
  }
}

/* ------------------------------------------------------------------ */
/* Discord presence                                                    */
/* ------------------------------------------------------------------ */

// The site remembers when the Discord status last flipped between online
// and offline, so every visitor sees the same "online for" / "last seen".

function presenceResponse(row) {
  let payload = {};

  try {
    payload = JSON.parse(row.payload || "{}");
  } catch {
    // Fall back to the bare status below
  }

  return {
    ...payload,
    status: row.status,
    since: row.since,
    last_online_at: row.last_online_at,
    checked_at: row.checked_at
  };
}

async function refreshPresence(env) {
  const existing = await env.DB.prepare(
    "SELECT status, since, last_online_at, checked_at, payload FROM discord_presence WHERE id = 1"
  ).first();

  const res = await fetch(`https://api.lanyard.rest/v1/users/${DISCORD_ID}`);
  const data = await res.json();

  if (!data.success) {
    throw new Error("Lanyard request failed");
  }

  const d = data.data;
  const user = d.discord_user || {};
  const status = d.discord_status || "offline";
  const now = new Date().toISOString();

  const customStatus = d.activities?.find(activity => activity.type === 4);

  const devices = [];
  if (d.active_on_discord_desktop) devices.push("Desktop");
  if (d.active_on_discord_mobile) devices.push("Mobile");
  if (d.active_on_discord_web) devices.push("Web");

  const payload = JSON.stringify({
    username: user.username || "",
    avatar_url: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : "https://cdn.discordapp.com/embed/avatars/0.png",
    custom_status: customStatus?.state || "",
    devices
  });

  const isOnline = status !== "offline";
  const wasOnline = existing ? existing.status !== "offline" : null;

  // "since" only moves when the status flips between online and offline,
  // not when it changes between online, idle and do not disturb.
  const since = existing && wasOnline === isOnline ? existing.since : now;
  const lastOnlineAt = isOnline ? now : existing?.last_online_at || null;

  const row = {
    status,
    since,
    last_online_at: lastOnlineAt,
    checked_at: now,
    payload
  };

  await env.DB.prepare(`
    INSERT INTO discord_presence (id, status, since, last_online_at, checked_at, payload)
    VALUES (1, ?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (id) DO UPDATE SET
      status = ?1,
      since = ?2,
      last_online_at = ?3,
      checked_at = ?4,
      payload = ?5
  `).bind(status, since, lastOnlineAt, now, payload).run();

  return row;
}

async function getDiscord(env) {
  const stored = await env.DB.prepare(
    "SELECT status, since, last_online_at, checked_at, payload FROM discord_presence WHERE id = 1"
  ).first();

  const age = stored ? Date.now() - new Date(stored.checked_at).getTime() : Infinity;

  if (stored && age < PRESENCE_MAX_AGE_SECONDS * 1000) {
    return json(presenceResponse(stored));
  }

  try {
    return json(presenceResponse(await refreshPresence(env)));
  } catch (error) {
    console.error("Discord failed:", error);

    // Lanyard is down - the last known state is better than nothing
    if (stored) return json({ ...presenceResponse(stored), stale: true });

    return json({ error: "Discord failed" }, 502);
  }
}

/* ------------------------------------------------------------------ */
/* Music archive                                                       */
/* ------------------------------------------------------------------ */

async function archiveTracks(env, tracks) {
  // Only inserts a play that isn't already archived, in one round trip
  const statements = [];

  for (const track of tracks) {
    if (track["@attr"]?.nowplaying) continue;
    if (!track.date?.uts) continue;

    const trackName = track.name || "";
    const artist = track.artist?.["#text"] || "";
    const albumArt = track.image?.[2]?.["#text"] || "";
    const trackUrl = track.url || "";
    const playedAt = new Date(Number(track.date.uts) * 1000).toISOString();

    if (!trackName) continue;

    statements.push(
      env.DB.prepare(`
        INSERT INTO nowplaying_archive
        (track_name, artist, album_art, track_url, played_at)
        SELECT ?1, ?2, ?3, ?4, ?5
        WHERE NOT EXISTS (
          SELECT 1
          FROM nowplaying_archive
          WHERE track_name = ?1
          AND artist = ?2
          AND played_at = ?5
        )
      `).bind(trackName, artist, albumArt, trackUrl, playedAt)
    );
  }

  if (!statements.length) return 0;

  const results = await env.DB.batch(statements);

  return results.reduce((total, result) => total + (result.meta?.changes || 0), 0);
}

// Works back through Last.fm history a few pages at a time until the last
// ARCHIVE_BACKFILL_DAYS days are archived. Progress is saved between runs.
async function backfillArchive(env) {
  let state = await getState(env, "archive_backfill");

  if (!state || state.days !== ARCHIVE_BACKFILL_DAYS) {
    const to = Math.floor(Date.now() / 1000);

    state = {
      days: ARCHIVE_BACKFILL_DAYS,
      from: to - ARCHIVE_BACKFILL_DAYS * 24 * 60 * 60,
      to,
      page: 1,
      done: false
    };
  }

  if (state.done) return { inserted: 0, done: true };

  let inserted = 0;

  for (let i = 0; i < ARCHIVE_BACKFILL_PAGES_PER_RUN && !state.done; i++) {
    const { tracks, totalPages } = await fetchRecentTracks({
      limit: ARCHIVE_PAGE_SIZE,
      page: state.page,
      from: state.from,
      to: state.to
    });

    inserted += await archiveTracks(env, tracks);

    state.page++;
    state.done = state.page > totalPages;

    await setState(env, "archive_backfill", state);
  }

  return { inserted, done: state.done };
}

async function syncArchive(env) {
  const { tracks } = await fetchRecentTracks({ limit: ARCHIVE_PAGE_SIZE });

  let inserted = await archiveTracks(env, tracks);

  const backfill = await backfillArchive(env);
  inserted += backfill.inserted;

  await setState(env, "archive_synced_at", new Date().toISOString());

  return { inserted, backfillDone: backfill.done };
}

async function updateArchive(env) {
  try {
    const result = await syncArchive(env);

    return json({
      success: true,
      inserted: result.inserted,
      catching_up: !result.backfillDone
    });
  } catch (error) {
    console.error("Archive update failed:", error);
    return json({ success: false, error: "Last.fm unavailable" }, 502);
  }
}

function archiveSince(range) {
  if (range === "week") return new Date(Date.now() - 7 * DAY_MS).toISOString();
  if (range === "month") return new Date(Date.now() - 30 * DAY_MS).toISOString();
  return "";
}

async function getArchiveTop(url, env) {
  const since = archiveSince(url.searchParams.get("range"));

  if (url.searchParams.get("type") === "artists") {
    const artists = await env.DB.prepare(`
      SELECT
        artist,
        MAX(album_art) AS album_art,
        COUNT(*) AS plays
      FROM nowplaying_archive
      WHERE played_at >= ? AND artist != ''
      GROUP BY artist
      ORDER BY plays DESC, MAX(played_at) DESC
      LIMIT 10
    `).bind(since).all();

    return json(artists.results);
  }

  const tracks = await env.DB.prepare(`
    SELECT
      track_name,
      artist,
      MAX(album_art) AS album_art,
      MAX(track_url) AS track_url,
      COUNT(*) AS plays
    FROM nowplaying_archive
    WHERE played_at >= ?
    GROUP BY track_name, artist
    ORDER BY plays DESC, MAX(played_at) DESC
    LIMIT 10
  `).bind(since).all();

  return json(tracks.results);
}

async function getArchiveRecent(env) {
  const tracks = await env.DB.prepare(`
    SELECT track_name, artist, album_art, track_url, played_at
    FROM nowplaying_archive
    ORDER BY played_at DESC
    LIMIT 30
  `).all();

  return json(tracks.results);
}

async function getArchiveStats(env) {
  const [totals, syncedAt, backfill] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS plays,
        COUNT(DISTINCT artist) AS artists,
        COUNT(DISTINCT track_name || '|' || artist) AS tracks,
        MIN(played_at) AS first_played_at
      FROM nowplaying_archive
    `).first(),
    getState(env, "archive_synced_at"),
    getState(env, "archive_backfill")
  ]);

  return json({
    plays: totals?.plays || 0,
    artists: totals?.artists || 0,
    tracks: totals?.tracks || 0,
    first_played_at: totals?.first_played_at || null,
    synced_at: syncedAt,
    catching_up: !backfill?.done
  });
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, ctx, url) {
  const { pathname } = url;
  const { method } = request;

  if (pathname === "/api/mood") return getMood(request, env, ctx);

  await ensureSchema(env);

  if (pathname === "/api/guestbook") {
    if (method === "GET") return getGuestbook(env);
    if (method === "POST") return postGuestbook(request, env);
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  }

  if (pathname === "/api/discord") return getDiscord(env);

  if (pathname === "/api/archive/update") return updateArchive(env);
  if (pathname === "/api/archive/top") return getArchiveTop(url, env);
  if (pathname === "/api/archive/recent") return getArchiveRecent(env);
  if (pathname === "/api/archive/stats") return getArchiveStats(env);

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (error) {
        console.error("API error:", error);
        return json({ error: "Something went wrong" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  // Runs on the schedule in wrangler.toml, whether or not anyone is visiting:
  // every minute it records the Discord status, and every tenth minute it
  // saves new Last.fm plays to the music archive.
  async scheduled(controller, env, ctx) {
    await ensureSchema(env);

    const jobs = [
      refreshPresence(env).catch(error => console.error("Presence check failed:", error))
    ];

    if (new Date(controller.scheduledTime).getUTCMinutes() % 10 === 0) {
      jobs.push(
        syncArchive(env).catch(error => console.error("Archive sync failed:", error))
      );
    }

    await Promise.all(jobs);
  }
};
