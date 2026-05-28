export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Guestbook - get messages
    if (url.pathname === "/api/guestbook" && request.method === "GET") {
      const messages = await env.DB.prepare(
        "SELECT name, message, created_at FROM guestbook ORDER BY id DESC LIMIT 25"
      ).all();

      return Response.json(messages.results);
    }

    // Guestbook - add message
    if (url.pathname === "/api/guestbook" && request.method === "POST") {
      const body = await request.json();
      if (body.website) {
  return Response.json({ success: true });
}
      const name = String(body.name || "").trim().slice(0, 24);
      const message = String(body.message || "").trim().slice(0, 180);

      if (!name || !message) {
        return Response.json(
          { error: "Name and message required" },
          { status: 400 }
        );
      }

      await env.DB.prepare(
        "INSERT INTO guestbook (name, message) VALUES (?, ?)"
      ).bind(name, message).run();

      return Response.json({ success: true });
    }

    // Gemini mood API
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
                  parts: [{ text: prompt }]
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

        return Response.json({ mood });
      } catch (error) {
        return Response.json({ mood: error.toString() });
      }
    }
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

    await env.DB.prepare(`
      INSERT INTO nowplaying_archive
      (track_name, artist, album_art, track_url, played_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(trackName, artist, albumArt, trackUrl, playedAt).run();
  }

  return Response.json({ success: true });
}

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