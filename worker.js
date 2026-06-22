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

const ip =
  request.headers.get("CF-Connecting-IP") || "unknown";

await env.DB.prepare(
  "INSERT INTO guestbook (name, message, ip) VALUES (?, ?, ?)"
).bind(name, message, ip).run();

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
// MUSIC ARCHIVE - update from Last.fm
if (url.pathname === "/api/archive/update") {
  const LASTFM_KEY = "be3c5d62a114a966685354a725e8738e";
  const LASTFM_USER = "hp173011";

  const response = await fetch(
    `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_KEY}&format=json&limit=10`
  );

  const data = await response.json();
  const tracks = data.recenttracks?.track || [];

  let inserted = 0;

  for (const track of tracks) {
    if (track["@attr"]?.nowplaying) continue;
    if (!track.date?.uts) continue;

    const trackName = track.name || "";
    const artist = track.artist?.["#text"] || "";
    const albumArt = track.image?.[2]?.["#text"] || "";
    const trackUrl = track.url || "";
    const playedAt = new Date(Number(track.date.uts) * 1000).toISOString();

    const uniqueKey = `${trackName}|${artist}|${track.date.uts}`;

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

      inserted++;
    }
  }

  return Response.json({
    success: true,
    inserted
  });
}
    return env.ASSETS.fetch(request);
  }
};