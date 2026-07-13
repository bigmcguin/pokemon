// All price-guide rows for one set, in a single query — lets the set view
// show ungraded prices for cards TCGPlayer hasn't priced yet (common for
// brand-new sets). Matched client-side by collector number + name.

import { getSql } from "../lib/db.js";

export const config = { maxDuration: 15 };

const dollars = (v) => (typeof v === "number" && v > 0 ? v / 100 : null);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=21600");

  const set = (req.query.set || "").toString().trim();
  if (!set) return res.status(400).json({ error: "set parameter is required" });

  const sqlp = getSql();
  if (!sqlp) return res.status(200).json({ available: false });

  try {
    const sql = await sqlp;
    // Guide set names are usually "Pokemon <set name>"; fall back to a
    // substring match for the odd ones out.
    let rows = await sql`
      SELECT id, product, number, loose, grade9, psa10 FROM price_guide
      WHERE lower(set_name) = ${"pokemon " + set.toLowerCase()}`;
    if (!rows.length) {
      rows = await sql`
        SELECT id, product, number, loose, grade9, psa10 FROM price_guide
        WHERE set_name ILIKE ${"%" + set + "%"} LIMIT 1000`;
    }
    return res.status(200).json({
      available: true,
      cards: rows.map(r => ({
        id: String(r.id),
        product: r.product,
        number: r.number,
        ungraded: dollars(r.loose),
        grade9: dollars(r.grade9),
        psa10: dollars(r.psa10),
      })),
    });
  } catch (err) {
    return res.status(200).json({ available: false, error: err.message });
  }
}
