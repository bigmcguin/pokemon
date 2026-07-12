// Cached proxy for the Pokémon TCG API.
// Two jobs: (1) attach the POKEMONTCG_API_KEY server-side so it never appears
// in the page, and (2) cache responses at Vercel's edge — the upstream API is
// often slow, so repeat visits to a set or search are served in milliseconds.

const UPSTREAM = "https://api.pokemontcg.io/v2/";
const ALLOWED_PATHS = new Set(["cards", "sets"]);

export default async function handler(req, res) {
  const { path, ...params } = req.query;
  if (!ALLOWED_PATHS.has(path)) {
    return res.status(400).json({ error: "path must be 'cards' or 'sets'" });
  }

  // Set lists barely change; card data updates daily with new prices.
  res.setHeader(
    "Cache-Control",
    path === "sets"
      ? "s-maxage=86400, stale-while-revalidate=172800"
      : "s-maxage=21600, stale-while-revalidate=86400"
  );

  const headers = {};
  if (process.env.POKEMONTCG_API_KEY) {
    headers["X-Api-Key"] = process.env.POKEMONTCG_API_KEY;
  }

  const qs = new URLSearchParams(params).toString();
  try {
    const upstream = await fetch(UPSTREAM + path + (qs ? "?" + qs : ""), { headers });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(body);
  } catch (err) {
    return res.status(502).json({ error: "Could not reach the Pokémon TCG API: " + err.message });
  }
}
