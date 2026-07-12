// Daily exchange rates for the AUD display toggle, from the free Frankfurter
// API (European Central Bank data). Cached at the edge for 12 hours.

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=86400");
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD,EUR");
    if (!r.ok) throw new Error("upstream responded with " + r.status);
    const j = await r.json();
    const aud = j.rates && j.rates.AUD;
    const eur = j.rates && j.rates.EUR;
    if (!aud || !eur) throw new Error("rates missing from response");
    return res.status(200).json({
      available: true,
      usdAud: aud,
      eurAud: aud / eur,
      date: j.date,
    });
  } catch (err) {
    return res.status(200).json({ available: false, error: err.message });
  }
}
