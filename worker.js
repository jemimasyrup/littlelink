export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // DISCORD STATUS + KV API
    if (url.pathname === "/api/discord") {
      const discordId = "783776027846639688";

      try {
        const res = await fetch(`https://api.lanyard.rest/v1/users/${discordId}`);
        const data = await res.json();

        if (!data.success) {
          return Response.json({
            error: "Discord failed"
          });
        }

        const status = data.data.discord_status || "offline";

        const oldStatus = await env.STATUS_KV.get("discord_status");

        if (oldStatus !== "offline" && status === "offline") {
          await env.STATUS_KV.put("last_offline_at", new Date().toISOString());
        }

        await env.STATUS_KV.put("discord_status", status);

        const lastOfflineAt = await env.STATUS_KV.get("last_offline_at");

        return Response.json({
          status,
          lastOfflineAt,
          discord: data.data
        });

      } catch (error) {
        return Response.json({
          error: error.toString()
        });
      }
    }

    // GEMINI MOOD API
    if (url.pathname === "/api/mood") {
      try {
        const LASTFM_KEY = "be3c5d62a114a966685354a725e8738e";
        const LASTFM_USER = "hp173011";

        const lastfm = await fetch(
          `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_KEY}&format=json&limit=5`
        );

        const lastfmData = await lastfm.json();
        const tracks = lastfmData.recenttracks?.track || [];

        const songs = tracks
          .map(track => `${track.name} by ${track.artist["#text"]}`)
          .join(", ");

        const prompt = `
Based on these recently played songs:

${songs}

Describe the user's mood in ONE short sentence.
Make it dramatic, funny, internet-y and stylish.
No quotation marks.
`;

        const gemini = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt }
                  ]
                }
              ]
            })
          }
        );

        const geminiData = await gemini.json();

        const mood =
          geminiData?.error?.message ||
          geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
          "emotionally unavailable";

        return Response.json({
          mood
        });

      } catch (error) {
        return Response.json({
          mood: error.toString()
        });
      }
    }
// MUSIC ARCHIVE - update from Last.fm
if (url.pathname === "/api/archive/update") {
  const LASTFM_KEY = "be3c5d62a114a966685354a725e8738e";
  const LASTFM_USER = "hp173011";

  const response = await fetch(
    `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_KEY}&format=json&limit=10`
  );

  const data = await response.json();
  const tracks = data.recenttracks?.track || [];

  for (const track of tracks) {
    if (track["@attr"]?.nowplaying) continue;

    const trackName = track.name;
    const artist = track.artist?.["#text"] || "";
    const albumArt = track.image?.[2]?.["#text"] || "";
    const trackUrl = track.url || "";
    const playedAt = track.date?.uts
      ? new Date(Number(track.date.uts) * 1000).toISOString()
      : new Date().toISOString();

    const existing = await env.DB.prepare(`
      SELECT id
      FROM nowplaying_archive
      WHERE track_name = ?
      AND artist = ?
      AND played_at = ?
      LIMIT 1
    `).bind(trackName, artist, playedAt).first();

    if (!existing) {
      await env.DB.prepare(`
        INSERT INTO nowplaying_archive
        (track_name, artist, album_art, track_url, played_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(trackName, artist, albumArt, trackUrl, playedAt).run();
    }
  }

  return Response.json({ success: true });
}

// MUSIC ARCHIVE - top songs
if (url.pathname === "/api/archive/top") {
  const range = url.searchParams.get("range") || "week";
  const days = range === "month" ? 30 : 7;

  const result = await env.DB.prepare(`
    SELECT
      track_name,
      artist,
      album_art,
      track_url,
      COUNT(*) as plays
    FROM nowplaying_archive
    WHERE datetime(played_at) >= datetime('now', ?)
    GROUP BY track_name, artist
    ORDER BY plays DESC
    LIMIT 10
  `).bind(`-${days} days`).all();

  return Response.json(result.results);
}

// MUSIC ARCHIVE - recent songs
if (url.pathname === "/api/archive/recent") {
  const result = await env.DB.prepare(`
    SELECT track_name, artist, album_art, track_url, played_at
    FROM nowplaying_archive
    ORDER BY datetime(played_at) DESC
    LIMIT 30
  `).all();

  return Response.json(result.results);
}
    return env.ASSETS.fetch(request);
  }
};