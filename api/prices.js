// Serverless proxy for the PriceCharting API.
// The paid token stays in the PRICECHARTING_TOKEN environment variable on
// Vercel — it is never sent to the browser. Responses are cached at Vercel's
// edge for 24 hours (card prices update daily at most), so repeat lookups of
// the same card cost zero API quota.
//
// Matching strategy: PriceCharting's single-best-match endpoint is strict, so
// instead we search their catalogue (/api/products) with a few query
// variations and pick the right product ourselves by comparing the card
// number, name and set. Only then do we fetch that product's prices.

const memoryCache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
const PC = "https://www.pricecharting.com";

// Prices normally arrive as integer US cents, but be liberal: accept numeric
// strings ("43000") and dollar strings ("$430.00" / "430.00") too.
const cents = (v) => {
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s]/g, "");
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    if (isNaN(n) || n <= 0) return null;
    return cleaned.includes(".") ? n : n / 100;
  }
  return typeof v === "number" && v > 0 ? v / 100 : null;
};
const norm = (s) => String(s || "").toLowerCase()
  .replace(/[^a-z0-9#& ]+/g, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pickBest(products, name, number, setName) {
  const nameTokens = norm(name).split(" ").filter(Boolean);
  const setTokens = norm(setName).split(" ").filter(t => t && t !== "pokemon");
  // "#121" must match as a whole number — "#12" must not match "#121".
  const numRe = number ? new RegExp("#" + escapeRe(number) + "(?![0-9])") : null;

  let best = null, bestScore = 0;
  for (const p of products) {
    const pn = norm(p["product-name"]);
    const cn = norm(p["console-name"]);
    if (!cn.includes("pokemon")) continue;
    let score = 0;
    if (numRe) {
      if (numRe.test(pn)) score += 5;
      else continue; // wrong collector number = wrong card
    }
    if (cn.includes("japanese")) score -= 2; // the app is English cards only
    if (nameTokens.length) {
      score += nameTokens.filter(t => pn.includes(t)).length / nameTokens.length * 3;
    }
    if (setTokens.length) {
      score += setTokens.filter(t => cn.includes(t)).length / setTokens.length * 3;
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

async function pcJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("PriceCharting responded with " + r.status);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", req.query.debug
    ? "no-store"
    : "s-maxage=86400, stale-while-revalidate=43200");

  const token = process.env.PRICECHARTING_TOKEN;
  if (!token) {
    return res.status(200).json({ configured: false });
  }

  const name = (req.query.name || "").toString().trim();
  const set = (req.query.set || "").toString().trim();
  const number = (req.query.number || "").toString().split("/")[0].trim();
  if (!name) {
    return res.status(400).json({ error: "name parameter is required" });
  }

  const cacheKey = norm("pokemon " + set + " " + name + " " + number);
  const hit = memoryCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return res.status(200).json(hit.value);
  }

  const numberPart = number ? "#" + number : "";
  const queries = [...new Set([
    ["pokemon", set, name, numberPart].join(" "),
    ["pokemon", name, numberPart].join(" "),
    ["pokemon", set, name].join(" "),
  ].map(q => q.replace(/\s+/g, " ").trim()))];

  let chosen = null;
  const tried = [];
  let lastCandidates = [];
  try {
    for (const q of queries) {
      tried.push(q);
      const j = await pcJson(PC + "/api/products?t=" + token + "&q=" + encodeURIComponent(q));
      lastCandidates = j.products || [];
      chosen = pickBest(lastCandidates, name, number, set);
      if (chosen) break;
    }
  } catch (err) {
    return res.status(502).json({ error: "Could not reach PriceCharting: " + err.message });
  }

  let value;
  if (!chosen) {
    value = { configured: true, found: false, query: tried.join(" | ") };
  } else {
    let product;
    try {
      product = await pcJson(PC + "/api/product?t=" + token + "&id=" + encodeURIComponent(chosen.id));
    } catch (err) {
      return res.status(502).json({ error: "Could not reach PriceCharting: " + err.message });
    }
    value = {
      configured: true,
      found: true,
      query: tried.join(" | "),
      match: {
        id: product.id,
        product: product["product-name"],
        set: product["console-name"],
      },
      // PriceCharting field names are inherited from video games; for trading
      // cards they map to grades as below (values arrive in US cents).
      prices: {
        ungraded: cents(product["loose-price"]),
        grade7: cents(product["cib-price"]),
        grade8: cents(product["new-price"]),
        grade9: cents(product["graded-price"]),
        grade95: cents(product["box-only-price"]),
        psa10: cents(product["manual-only-price"]),
        bgs10: cents(product["bgs-10-price"]),
        cgc10: cents(product["condition-17-price"]),
        sgc10: cents(product["condition-18-price"]),
      },
    };
    if (req.query.debug) value.upstream = product;
  }
  if (req.query.debug) {
    value.candidates = lastCandidates.slice(0, 5).map(p =>
      ({ id: p.id, product: p["product-name"], set: p["console-name"] }));
    return res.status(200).json(value); // don't cache debug responses
  }

  memoryCache.set(cacheKey, { at: Date.now(), value });
  return res.status(200).json(value);
}
