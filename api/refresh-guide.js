// Daily import of PriceCharting's Pokémon price-guide CSV into Postgres.
// Runs on a Vercel cron (see vercel.json) and can be triggered manually with
// ?secret=<CRON_SECRET>. One CSV download replaces tens of thousands of
// per-card API calls — this is the bulk path PriceCharting recommends.

import { getSql } from "../lib/db.js";
import { parseCsv, mapGuideRow } from "../lib/guide.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CRON_SECRET;
  const auth = req.headers["authorization"] || "";
  const authorised = secret && (auth === "Bearer " + secret || req.query.secret === secret);
  if (!authorised) {
    return res.status(401).json({ error: "Unauthorised — set a CRON_SECRET env var and pass it as ?secret=" });
  }

  const token = process.env.PRICECHARTING_TOKEN;
  if (!token) return res.status(500).json({ error: "PRICECHARTING_TOKEN is not set" });

  const sqlp = getSql();
  if (!sqlp) {
    return res.status(500).json({ error: "No database configured — create a Neon Postgres store in Vercel's Storage tab, connect it to this project, and redeploy" });
  }
  const sql = await sqlp;

  const csvUrl = process.env.PRICECHARTING_CSV_URL ||
    "https://www.pricecharting.com/price-guide/download-custom?t=" + token + "&category=pokemon-cards";

  let text;
  try {
    const r = await fetch(csvUrl, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("CSV download failed: HTTP " + r.status);
    const len = parseInt(r.headers.get("content-length") || "0", 10);
    if (len > 250 * 1024 * 1024) {
      throw new Error("CSV is unexpectedly large (" + len + " bytes) — set PRICECHARTING_CSV_URL to a Pokémon-only download link");
    }
    text = await r.text();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (text.slice(0, 300).toLowerCase().includes("<html")) {
    return res.status(502).json({
      error: "Got an HTML page instead of CSV — the download URL or token is wrong. Copy the CSV link from pricecharting.com's price-guide download page into a PRICECHARTING_CSV_URL env var.",
    });
  }

  const parsed = parseCsv(text);
  const items = parsed.map(mapGuideRow).filter(Boolean);
  if (!items.length) {
    return res.status(502).json({ error: "No Pokémon rows found in the CSV", csvRows: parsed.length, headers: Object.keys(parsed[0] || {}) });
  }

  await sql`CREATE TABLE IF NOT EXISTS price_guide (
    id text PRIMARY KEY, product text, set_name text, number text,
    loose int, grade7 int, grade8 int, grade9 int, grade95 int,
    psa10 int, bgs10 int, cgc10 int, sgc10 int,
    updated_at timestamptz DEFAULT now())`;

  const BATCH = 1000;
  let upserted = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const b = items.slice(i, i + BATCH);
    await sql`
      INSERT INTO price_guide (id, product, set_name, number, loose, grade7, grade8, grade9, grade95, psa10, bgs10, cgc10, sgc10, updated_at)
      SELECT u.*, now() FROM UNNEST(
        ${b.map(x => x.id)}::text[], ${b.map(x => x.product)}::text[],
        ${b.map(x => x.set_name)}::text[], ${b.map(x => x.number)}::text[],
        ${b.map(x => x.loose)}::int[], ${b.map(x => x.grade7)}::int[],
        ${b.map(x => x.grade8)}::int[], ${b.map(x => x.grade9)}::int[],
        ${b.map(x => x.grade95)}::int[], ${b.map(x => x.psa10)}::int[],
        ${b.map(x => x.bgs10)}::int[], ${b.map(x => x.cgc10)}::int[],
        ${b.map(x => x.sgc10)}::int[]
      ) AS u(id, product, set_name, number, loose, grade7, grade8, grade9, grade95, psa10, bgs10, cgc10, sgc10)
      ON CONFLICT (id) DO UPDATE SET
        product = EXCLUDED.product, set_name = EXCLUDED.set_name, number = EXCLUDED.number,
        loose = EXCLUDED.loose, grade7 = EXCLUDED.grade7, grade8 = EXCLUDED.grade8,
        grade9 = EXCLUDED.grade9, grade95 = EXCLUDED.grade95, psa10 = EXCLUDED.psa10,
        bgs10 = EXCLUDED.bgs10, cgc10 = EXCLUDED.cgc10, sgc10 = EXCLUDED.sgc10,
        updated_at = now()`;
    upserted += b.length;
  }

  return res.status(200).json({ ok: true, pokemonRows: upserted, csvRows: parsed.length });
}
