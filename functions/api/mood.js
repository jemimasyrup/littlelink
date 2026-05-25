export async function onRequestGet(context) {

  const GEMINI_KEY =
    context.env.GEMINI_API_KEY;

  const LASTFM_KEY =
    "be3c5d62a114a966685354a725e8738e";

  const LASTFM_USER =
    "hp173011";

  try {

    const lastfm =
      await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_KEY}&format=json&limit=5`
      );

    const lastfmData =
      await lastfm.json();

    const tracks =
      lastfmData.recenttracks?.track || [];

    const songs =
      tracks.map(track =>
        `${track.name} by ${track.artist["#text"]}`
      ).join(", ");

    const prompt = `
Based on these recently played songs:

${songs}

Describe the user's current mood in ONE short sentence.
Make it funny, dramatic, internet-y, and stylish.
Do not use quotation marks.
`;

    const gemini =
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
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

    const geminiData =
      await gemini.json();

    const mood =
      geminiData
        ?.candidates?.[0]
        ?.content?.parts?.[0]
        ?.text ||
      "too mysterious to analyse";

    return Response.json({
      mood
    });

  } catch (error) {

    return Response.json({
      mood: "emotionally unavailable"
    });

  }
}