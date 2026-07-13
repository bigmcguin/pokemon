// Serverless proxy for the PriceCharting API.
//
// - The paid token stays in the PRICECHARTING_TOKEN environment variable on
//   Vercel — it is never sent to the browser.
// - Responses are cached at Vercel's edge for 24 hours, so repeat lookups of
//   the same card cost zero upstream quota.
// - Upstream calls are throttled to ~1 per second (PriceCharting's limit;
//   exceeding it gets the account blocked).
// - Cards are resolved to a PriceCharting product ID once; the browser stores
//   the ID and sends it back as ?pcid=, so later lookups are a single
//   fetch-by-ID — search results can shift, IDs don't.

import { getSql } from "../lib/db.js";

export const config = { maxDuration: 30 };

const memoryCache = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;
const PC = "https://www.pricecharting.com";

// The daily price-guide import (api/refresh-guide.js) is the preferred
// source: complete graded data, no rate limits. Returns null when the guide
// DB isn't configured or doesn't have the product.
async function guideLookup(id) {
  const sqlp = getSql();
  if (!sqlp) return null;
  try {
    const sql = await sqlp;
    const rows = await sql`SELECT * FROM price_guide WHERE id = ${String(id)}`;
    return rows[0] || null;
  } catch (err) {
    return null; // table missing / db hiccup — fall through to the live API
  }
}

const centsInt = (v) => (typeof v === "number" && v > 0 ? v / 100 : null);

// ---------- rate limiter: ≥1.1s between upstream calls (per instance) ----------
const RATE_MS = 1100;
let queueTail = Promise.resolve();
let nextSlot = 0;
function rateLimited(fn) {
  const run = queueTail.then(async () => {
    const wait = nextSlot - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    nextSlot = Date.now() + RATE_MS;
    return fn();
  });
  queueTail = run.catch(() => {});
  return run;
}

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
  return rateLimited(async () => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!r.ok) throw new Error("PriceCharting responded with " + r.status);
    return r.json();
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", req.query.debug
    ? "no-store"
    : "s-maxage=21600, stale-while-revalidate=21600");

  const token = process.env.PRICECHARTING_TOKEN;
  if (!token) {
    return res.status(200).json({ configured: false });
  }

  const name = (req.query.name || "").toString().trim();
  const set = (req.query.set || "").toString().trim();
  const number = (req.query.number || "").toString().split("/")[0].trim();
  const pcidParam = (req.query.pcid || "").toString().trim();
  if (!name && !pcidParam) {
    return res.status(400).json({ error: "name or pcid parameter is required" });
  }

  const cacheKey = pcidParam ? "id:" + pcidParam : norm("pokemon " + set + " " + name + " " + number);
  const hit = memoryCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS && !req.query.debug) {
    return res.status(200).json(hit.value);
  }

  const tried = [];
  let lastCandidates = [];

  async function resolveIdBySearch() {
    const numberPart = number ? "#" + number : "";
    const queries = [...new Set([
      ["pokemon", set, name, numberPart].join(" "),
      ["pokemon", name, numberPart].join(" "),
      ["pokemon", set, name].join(" "),
    ].map(q => q.replace(/\s+/g, " ").trim()))];
    for (const q of queries) {
      tried.push(q);
      const j = await pcJson(PC + "/api/products?t=" + token + "&q=" + encodeURIComponent(q));
      lastCandidates = j.products || [];
      const chosen = pickBest(lastCandidates, name, number, set);
      if (chosen) return chosen.id;
    }
    return null;
  }

  async function fetchProduct(id) {
    const p = await pcJson(PC + "/api/product?t=" + token + "&id=" + encodeURIComponent(id));
    return (p && p.id && p.status !== "error") ? p : null;
  }

  let product = null;
  let row = null;
  try {
    if (pcidParam) {
      row = await guideLookup(pcidParam);
      if (!row) {
        product = await fetchProduct(pcidParam);
        tried.push("pcid:" + pcidParam);
      }
    }
    if (!row && !product && name) {
      // No stored ID (or it went stale) — resolve via catalogue search once.
      const id = await resolveIdBySearch();
      if (id) {
        row = await guideLookup(id);
        if (!row) product = await fetchProduct(id);
      }
    }
  } catch (err) {
    return res.status(502).json({ error: "Could not reach PriceCharting: " + err.message });
  }

  let value;
  if (row) {
    value = {
      configured: true,
      found: true,
      source: "price-guide",
      guideUpdated: row.updated_at,
      query: tried.join(" | ") || "pcid:" + pcidParam,
      match: { id: String(row.id), product: row.product, set: row.set_name },
      prices: {
        ungraded: centsInt(row.loose),
        grade7: centsInt(row.grade7),
        grade8: centsInt(row.grade8),
        grade9: centsInt(row.grade9),
        grade95: centsInt(row.grade95),
        psa10: centsInt(row.psa10),
        bgs10: centsInt(row.bgs10),
        cgc10: centsInt(row.cgc10),
        sgc10: centsInt(row.sgc10),
      },
    };
    if (req.query.debug) value.upstream = row;
  } else if (product) {
    value = {
      configured: true,
      found: true,
      source: "live-api",
      query: tried.join(" | "),
      match: {
        id: String(product.id),
        product: product["product-name"],
        set: product["console-name"],
      },
      // PriceCharting field names are inherited from video games; for trading
      // cards they map to grades as below (values arrive in US cents). Fields
      // are absent when a grade has no sales — cents() returns null for those.
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
  } else {
    value = { configured: true, found: false, query: tried.join(" | ") };
  }
  if (req.query.debug) {
    value.candidates = lastCandidates.slice(0, 5).map(p =>
      ({ id: p.id, product: p["product-name"], set: p["console-name"] }));
    return res.status(200).json(value); // don't cache debug responses
  }

  // Don't memory-cache live-API or not-found results when a guide DB exists:
  // the nightly import may fill them in, and the next request should pick
  // that up rather than a stale fallback.
  if (value.source === "price-guide" || !getSql()) {
    memoryCache.set(cacheKey, { at: Date.now(), value });
  }
  return res.status(200).json(value);
}
