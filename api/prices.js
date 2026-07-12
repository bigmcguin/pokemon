// Serverless proxy for the PriceCharting API.
// The paid token stays in the PRICECHARTING_TOKEN environment variable on
// Vercel — it is never sent to the browser. Responses are cached at Vercel's
// edge for 24 hours (card prices update daily at most), so repeat lookups of
// the same card cost zero API quota.

const memoryCache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

const cents = (v) => (typeof v === "number" && v > 0 ? v / 100 : null);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=43200");

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

  const q = ["pokemon", set, name, number ? "#" + number : ""].join(" ").replace(/\s+/g, " ").trim();
  const cacheKey = q.toLowerCase();

  const hit = memoryCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return res.status(200).json(hit.value);
  }

  let product;
  try {
    const r = await fetch(
      "https://www.pricecharting.com/api/product?t=" + token + "&q=" + encodeURIComponent(q)
    );
    if (!r.ok) {
      return res.status(502).json({ error: "PriceCharting responded with " + r.status });
    }
    product = await r.json();
  } catch (err) {
    return res.status(502).json({ error: "Could not reach PriceCharting: " + err.message });
  }

  let value;
  if (product.status === "error" || !product.id) {
    value = { configured: true, found: false, query: q };
  } else {
    value = {
      configured: true,
      found: true,
      query: q,
      match: {
        id: product.id,
        product: product["product-name"],
        set: product["console-name"],
      },
      // PriceCharting field names are inherited from video games; for trading
      // cards they map to grades as below (values arrive in US cents).
      prices: {
        ungraded: cents(product["loose-price"]),
        grade9: cents(product["graded-price"]),
        grade95: cents(product["box-only-price"]),
        psa10: cents(product["manual-only-price"]),
        bgs10: cents(product["bgs-10-price"]),
        cgc10: cents(product["condition-17-price"]),
        sgc10: cents(product["condition-18-price"]),
      },
    };
  }

  memoryCache.set(cacheKey, { at: Date.now(), value });
  return res.status(200).json(value);
}
