const LASTFM_KEY = "be3c5d62a114a966685354a725e8738e";
const LASTFM_USER = "hp173011";
const DISCORD_ID = "783776027846639688";

// gemini-2.0-flash has been retired by Google. Override with a GEMINI_MODEL
// variable in the Cloudflare dashboard / wrangler.toml if this one is retired too.
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

const MOOD_CACHE_SECONDS = 600;
const GUESTBOOK_COOLDOWN_SECONDS = 30;

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

async function fetchRecentTracks(limit) {
  const response = await fetch(
    `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_KEY}&format=json&limit=${limit}`
  );

  if (!response.ok) {
    throw new Error(`Last.fm responded with ${response.status}`);
  }

  const data = await response.json();
  const tracks = data.recenttracks?.track || [];

  // Last.fm returns a bare object instead of an array when there is one track
  return Array.isArray(tracks) ? tracks : [tracks];
}

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

    const tracks = await fetchRecentTracks(5);

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

async function getDiscord() {
  try {
    const res = await fetch(`https://api.lanyard.rest/v1/users/${DISCORD_ID}`);
    const data = await res.json();

    if (!data.success) {
      return json({ error: "Discord failed" }, 502);
    }

    const d = data.data;

    return json({
      status: d.discord_status,
      discord_user: d.discord_user,
      activities: d.activities,
      listening_to_spotify: d.listening_to_spotify,
      spotify: d.spotify
    });
  } catch (error) {
    console.error("Discord failed:", error);
    return json({ error: "Discord failed" }, 502);
  }
}

async function updateArchive(env) {
  let tracks;

  try {
    tracks = await fetchRecentTracks(50);
  } catch (error) {
    console.error("Archive update failed:", error);
    return json({ success: false, error: "Last.fm unavailable" }, 502);
  }

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

  let inserted = 0;

  if (statements.length) {
    const results = await env.DB.batch(statements);
    inserted = results.reduce((total, result) => total + (result.meta?.changes || 0), 0);
  }

  return json({ success: true, inserted });
}

async function getArchiveTop(url, env) {
  const days = url.searchParams.get("range") === "month" ? 30 : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

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
    LIMIT 25
  `).all();

  return json(tracks.results);
}

async function handleApi(request, env, ctx, url) {
  const { pathname } = url;
  const { method } = request;

  if (pathname === "/api/guestbook") {
    if (method === "GET") return getGuestbook(env);
    if (method === "POST") return postGuestbook(request, env);
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  }

  if (pathname === "/api/mood") return getMood(request, env, ctx);
  if (pathname === "/api/discord") return getDiscord();

  if (pathname === "/api/archive/update") return updateArchive(env);
  if (pathname === "/api/archive/top") return getArchiveTop(url, env);
  if (pathname === "/api/archive/recent") return getArchiveRecent(env);

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
  }
};
