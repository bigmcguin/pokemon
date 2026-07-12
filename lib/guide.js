// CSV parsing and field mapping for PriceCharting's price-guide download.

// Minimal CSV parser: quoted fields, "" escapes, CRLF. Returns one object per
// row keyed by the lowercased header names.
export function parseCsv(text) {
  const rows = [];
  let field = "", record = [], inQuotes = false;
  const pushField = () => { record.push(field); field = ""; };
  const pushRecord = () => {
    if (record.length > 1 || record[0] !== "") rows.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") pushField();
    else if (ch === "\n") { pushField(); pushRecord(); }
    else if (ch !== "\r") field += ch;
  }
  pushField(); pushRecord();

  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map(h => h.trim().toLowerCase());
  return data.map(r => {
    const o = {};
    keys.forEach((k, idx) => { o[k] = r[idx]; });
    return o;
  });
}

// CSV prices are dollar-formatted ("$1,868.00"); the JSON API uses integer
// cents. Store everything as integer cents: values with a decimal point are
// dollars, bare integers are assumed to already be cents.
export function dollarsToCents(v) {
  if (v == null) return null;
  const cleaned = String(v).replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  if (isNaN(n) || n <= 0) return null;
  return Math.round(cleaned.includes(".") ? n * 100 : n);
}

// "Meowth ex #121" -> "121"
export function extractNumber(productName) {
  const m = String(productName || "").match(/#([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

// Map a parsed CSV row to a price_guide table row (null if not a Pokémon row).
export function mapGuideRow(r) {
  const id = r["id"];
  const setName = r["console-name"] || "";
  if (!id || !setName.toLowerCase().includes("pokemon")) return null;
  return {
    id: String(id),
    product: r["product-name"] || "",
    set_name: setName,
    number: extractNumber(r["product-name"]),
    loose: dollarsToCents(r["loose-price"]),
    grade7: dollarsToCents(r["cib-price"]),
    grade8: dollarsToCents(r["new-price"]),
    grade9: dollarsToCents(r["graded-price"]),
    grade95: dollarsToCents(r["box-only-price"]),
    psa10: dollarsToCents(r["manual-only-price"]),
    bgs10: dollarsToCents(r["bgs-10-price"]),
    cgc10: dollarsToCents(r["condition-17-price"]),
    sgc10: dollarsToCents(r["condition-18-price"]),
  };
}
