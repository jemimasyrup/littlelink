export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // GEMINI MOOD API
    if (url.pathname === "/api/mood") {

      try {

        const LASTFM_KEY =
          "be3c5d62a114a966685354a725e8738e";

        const LASTFM_USER =
          "hp173011";

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

Describe the user's mood in ONE short sentence.
Make it dramatic, funny, internet-y and stylish.
No quotation marks.
`;

        const gemini =
          await fetch(
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

        const geminiData =
          await gemini.json();

    const mood =
  geminiData?.error?.message ||
  geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
  "emotionally unavailable";

        return new Response(
          JSON.stringify({ mood }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {

        return new Response(
          JSON.stringify({
            mood: error.toString()
          }),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      }

    }

    // STATIC FILES
    return env.ASSETS.fetch(request);

  }
}