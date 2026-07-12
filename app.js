(() => {
  "use strict";

  const API = "https://api.pokemontcg.io/v2";

  const DEFAULT_MULTIPLIERS = [
    { key: "psa10",  label: "PSA 10",  mult: 4.0 },
    { key: "psa9",   label: "PSA 9",   mult: 1.6 },
    { key: "psa8",   label: "PSA 8",   mult: 1.1 },
    { key: "bgs95",  label: "BGS 9.5", mult: 3.0 },
    { key: "cgc10",  label: "CGC 10",  mult: 3.0 },
    { key: "cgc95",  label: "CGC 9.5", mult: 1.5 },
  ];

  const $ = (id) => document.getElementById(id);
  const state = {
    sets: [],
    searchResults: [],
    setCards: [],
    setCardsCache: new Map(), // set id -> sorted cards
  };

  // ---------- Settings (localStorage) ----------
  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("pcv-settings") || "{}"); } catch (e) {}
    return {
      apiKey: saved.apiKey || "",
      multipliers: DEFAULT_MULTIPLIERS.map(d => ({
        ...d,
        mult: (saved.multipliers && typeof saved.multipliers[d.key] === "number")
          ? saved.multipliers[d.key] : d.mult,
      })),
    };
  }
  const settings = loadSettings();

  function apiHeaders() {
    return settings.apiKey ? { "X-Api-Key": settings.apiKey } : {};
  }

  function renderSettingsForm() {
    $("apiKey").value = settings.apiKey;
    $("multGrid").innerHTML = settings.multipliers.map(m => `
      <div>
        <label for="mult-${m.key}">${m.label}</label>
        <input id="mult-${m.key}" type="number" step="0.1" min="0" value="${m.mult}">
      </div>`).join("");
  }

  $("settingsToggle").addEventListener("click", () => {
    $("settings").classList.toggle("open");
    renderSettingsForm();
  });

  $("saveSettings").addEventListener("click", () => {
    const multipliers = {};
    settings.multipliers.forEach(m => {
      const v = parseFloat($("mult-" + m.key).value);
      if (!isNaN(v) && v >= 0) { m.mult = v; }
      multipliers[m.key] = m.mult;
    });
    settings.apiKey = $("apiKey").value.trim();
    localStorage.setItem("pcv-settings", JSON.stringify({ apiKey: settings.apiKey, multipliers }));
    $("settings").classList.remove("open");
  });

  // ---------- Formatting helpers ----------
  const fmtUSD = (n) => n == null ? "—" : "US$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtEUR = (n) => n == null ? "—" : "€" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function bestMarketPrice(card) {
    const prices = card.tcgplayer && card.tcgplayer.prices;
    if (!prices) return null;
    let best = null;
    for (const variant of Object.values(prices)) {
      const m = variant && (variant.market ?? variant.mid);
      if (typeof m === "number" && (best === null || m > best)) best = m;
    }
    return best;
  }

  function ebaySoldLink(card, gradeLabel) {
    const q = [card.name, card.number + "/" + (card.set.printedTotal || ""), card.set.name, gradeLabel || ""]
      .join(" ").trim();
    return "https://www.ebay.com.au/sch/i.html?_nkw=" + encodeURIComponent(q) +
           "&LH_Sold=1&LH_Complete=1";
  }

  function priceChartingLink(card) {
    const q = "pokemon " + card.name + " " + card.number;
    return "https://www.pricecharting.com/search-products?type=prices&q=" + encodeURIComponent(q);
  }

  // Collector-number sort: plain numbers first (1, 2, … 10, … 130), then
  // lettered series like TG01/GG12/SWSH250 grouped by prefix.
  function numberSortKey(n) {
    const m = String(n).trim().match(/^([A-Za-z]*)\s*0*(\d+)/);
    if (!m) return { prefix: "~" + String(n).toUpperCase(), num: 0 };
    return { prefix: m[1].toUpperCase(), num: parseInt(m[2], 10) };
  }
  function byCollectorNumber(a, b) {
    const ka = numberSortKey(a.number), kb = numberSortKey(b.number);
    if (ka.prefix !== kb.prefix) {
      if (!ka.prefix) return -1;
      if (!kb.prefix) return 1;
      return ka.prefix.localeCompare(kb.prefix);
    }
    return ka.num - kb.num;
  }

  function setStatus(msg, isError) {
    $("status").textContent = msg || "";
    $("status").classList.toggle("error", !!isError);
  }

  // ---------- Views / routing ----------
  function showHome() {
    $("homeView").hidden = false;
    $("setView").hidden = true;
  }

  function route() {
    const m = location.hash.match(/^#set=(.+)$/);
    if (m) {
      openSet(decodeURIComponent(m[1]));
    } else {
      showHome();
      if (!state.searchResults.length) setStatus("");
    }
  }
  window.addEventListener("hashchange", route);
  $("homeLink").addEventListener("click", () => { location.hash = ""; });

  // ---------- Set browser ----------
  async function loadSets() {
    try {
      const res = await fetch(API + "/sets?pageSize=250&orderBy=-releaseDate", { headers: apiHeaders() });
      if (!res.ok) throw new Error("API responded with " + res.status);
      const json = await res.json();
      state.sets = json.data || [];
      renderSets();
    } catch (err) {
      $("setsList").innerHTML =
        `<p style="color:var(--muted);text-align:center;padding:1rem">Couldn't load the set list (${err.message}). Refresh to retry.</p>`;
    }
  }

  function renderSets() {
    // Sets arrive newest-first; group consecutive runs of the same series
    // (Scarlet & Violet, Sword & Shield, …) under a heading.
    let html = "";
    let currentSeries = null;
    let open = false;
    for (const s of state.sets) {
      if (s.series !== currentSeries) {
        if (open) html += "</div>";
        currentSeries = s.series;
        html += `<div class="series-title">${s.series}</div><div class="sets-grid">`;
        open = true;
      }
      html += `
        <div class="set-tile" data-set="${s.id}">
          <img src="${s.images.logo}" alt="${s.name}" loading="lazy">
          <div class="set-name">${s.name}</div>
          <div class="set-meta">${s.total} cards · ${s.releaseDate || ""}</div>
        </div>`;
    }
    if (open) html += "</div>";
    $("setsList").innerHTML = html;
    document.querySelectorAll(".set-tile").forEach(tile => {
      tile.addEventListener("click", () => { location.hash = "set=" + encodeURIComponent(tile.dataset.set); });
    });
  }

  async function fetchAllSetCards(setId) {
    if (state.setCardsCache.has(setId)) return state.setCardsCache.get(setId);
    const all = [];
    let page = 1;
    while (true) {
      const res = await fetch(
        API + "/cards?q=" + encodeURIComponent("set.id:" + setId) + "&pageSize=250&page=" + page,
        { headers: apiHeaders() }
      );
      if (!res.ok) throw new Error("API responded with " + res.status);
      const json = await res.json();
      all.push(...(json.data || []));
      if (!json.data || !json.data.length || all.length >= (json.totalCount || 0)) break;
      page++;
    }
    all.sort(byCollectorNumber);
    state.setCardsCache.set(setId, all);
    return all;
  }

  async function openSet(setId) {
    $("homeView").hidden = true;
    $("setView").hidden = false;
    $("setCards").innerHTML = "";

    const set = state.sets.find(s => s.id === setId);
    $("setHeader").innerHTML = set ? `
      <img src="${set.images.logo}" alt="${set.name}">
      <div class="set-header-text">
        <h2>${set.name}</h2>
        <p>${set.series} · ${set.total} cards · Released ${set.releaseDate || "?"}</p>
      </div>` : "";

    setStatus("Loading cards…");
    try {
      const cards = await fetchAllSetCards(setId);
      state.setCards = cards;
      setStatus(`${cards.length} cards — in collector-number order. Tap a card for prices.`);
      renderTiles($("setCards"), cards, "set");
    } catch (err) {
      setStatus("Couldn't load this set (" + err.message + "). Go back and try again.", true);
    }
  }

  // ---------- Search ----------
  async function search() {
    const raw = $("query").value.trim();
    if (!raw) return;
    location.hash = "";
    showHome();

    const numMatch = raw.match(/^(.*?)\s+(\d{1,3})$/);
    let q;
    if (numMatch && numMatch[1].trim()) {
      q = `name:"${numMatch[1].trim()}*" number:${numMatch[2]}`;
    } else {
      q = `name:"${raw}*"`;
    }

    setStatus("Searching…");
    $("results").innerHTML = "";

    const url = API + "/cards?q=" + encodeURIComponent(q) +
      "&orderBy=" + encodeURIComponent($("sort").value) +
      "&pageSize=60";

    try {
      const res = await fetch(url, { headers: apiHeaders() });
      if (!res.ok) throw new Error("API responded with " + res.status);
      const json = await res.json();
      state.searchResults = json.data || [];
      if (!state.searchResults.length) {
        setStatus(`No cards found for “${raw}”. Try a shorter name (e.g. just “Charizard”).`);
        return;
      }
      setStatus(`${json.totalCount ?? state.searchResults.length} card(s) found — showing ${state.searchResults.length}. Tap a card for prices.`);
      renderTiles($("results"), state.searchResults, "search");
    } catch (err) {
      setStatus(
        "Couldn't reach the Pokémon TCG API (" + err.message + "). " +
        "The free API is sometimes slow or rate-limited — wait a moment and try again, " +
        "or add a free API key under ⚙ Settings.", true);
    }
  }

  function renderTiles(container, cards, source) {
    container.innerHTML = cards.map((c, i) => {
      const price = bestMarketPrice(c);
      return `
        <div class="card-tile" data-idx="${i}" data-src="${source}">
          <img src="${c.images.small}" alt="${c.name}" loading="lazy">
          <div class="name">${c.name}</div>
          <div class="set">${c.set.name} · ${c.number}/${c.set.printedTotal || "?"} · ${c.rarity || "—"}</div>
          <div class="price">${price != null ? fmtUSD(price) + " raw" : "no price data"}</div>
        </div>`;
    }).join("");
    container.querySelectorAll(".card-tile").forEach(tile => {
      tile.addEventListener("click", () => {
        const list = tile.dataset.src === "set" ? state.setCards : state.searchResults;
        openDetail(list[tile.dataset.idx]);
      });
    });
  }

  // ---------- Graded prices (via our Vercel backend) ----------
  async function fetchGradedPrices(card) {
    const u = "/api/prices" +
      "?name=" + encodeURIComponent(card.name) +
      "&set=" + encodeURIComponent(card.set.name) +
      "&number=" + encodeURIComponent(card.number);
    const res = await fetch(u, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("backend responded with " + res.status);
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) throw new Error("no backend on this host");
    return res.json();
  }

  function estimatesTableHTML(card, raw, note) {
    if (raw == null) return `<div class="disclaimer">${note}</div>`;
    const rows = settings.multipliers.map(m => `
      <tr>
        <td>${m.label}</td>
        <td class="num">×${m.mult}</td>
        <td class="num">${fmtUSD(raw * m.mult)}</td>
        <td><a class="grade-link" href="${ebaySoldLink(card, m.label)}" target="_blank" rel="noopener">eBay sold ↗</a></td>
      </tr>`).join("");
    return `
      <div class="section-title">Estimated graded values</div>
      <table>
        <tr><th>Grade</th><th class="num">Multiplier</th><th class="num">Estimate</th><th>Check real sales</th></tr>
        ${rows}
      </table>
      <div class="disclaimer">${note} Estimates = highest raw market price × your multiplier (edit in ⚙ Settings).</div>`;
  }

  function gradedTableHTML(card, data) {
    const rows = [
      ["Ungraded", data.prices.ungraded, ""],
      ["Grade 9 (PSA 9)", data.prices.grade9, "PSA 9"],
      ["Grade 9.5", data.prices.grade95, "9.5"],
      ["PSA 10", data.prices.psa10, "PSA 10"],
      ["BGS 10", data.prices.bgs10, "BGS 10"],
      ["CGC 10", data.prices.cgc10, "CGC 10"],
      ["SGC 10", data.prices.sgc10, "SGC 10"],
    ].filter(([, v]) => v != null);
    if (!rows.length) return null;
    return `
      <div class="section-title">Graded prices — PriceCharting (USD)</div>
      <table>
        <tr><th>Grade</th><th class="num">Price</th><th>Check real sales</th></tr>
        ${rows.map(([label, v, ebayLabel]) => `
          <tr>
            <td>${label}</td>
            <td class="num">${fmtUSD(v)}</td>
            <td><a class="grade-link" href="${ebaySoldLink(card, ebayLabel)}" target="_blank" rel="noopener">eBay sold ↗</a></td>
          </tr>`).join("")}
      </table>
      <div class="disclaimer">
        Matched to “${data.match.product}” (${data.match.set}) on PriceCharting — if that's the wrong
        card, use the PriceCharting link below to find the right one.
      </div>`;
  }

  async function fillGradedSection(card, raw) {
    const el = $("gradedSection");
    if (!el) return;
    try {
      const data = await fetchGradedPrices(card);
      if (!data.configured) {
        el.innerHTML = estimatesTableHTML(card, raw,
          "Live graded prices aren't set up yet (add a PriceCharting token on Vercel).");
        return;
      }
      if (!data.found) {
        el.innerHTML = estimatesTableHTML(card, raw,
          "PriceCharting had no match for this card, so these are estimates.");
        return;
      }
      const table = gradedTableHTML(card, data);
      el.innerHTML = table || estimatesTableHTML(card, raw,
        "PriceCharting matched this card but has no graded prices for it yet, so these are estimates.");
    } catch (err) {
      el.innerHTML = estimatesTableHTML(card, raw,
        "Live graded prices unavailable here, so these are estimates.");
    }
  }

  // ---------- Detail view ----------
  function openDetail(card) {
    const raw = bestMarketPrice(card);
    const tcg = card.tcgplayer;
    const cm = card.cardmarket;

    let variantRows = "";
    if (tcg && tcg.prices) {
      variantRows = Object.entries(tcg.prices).map(([variant, p]) => `
        <tr>
          <td>${variant.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase())}</td>
          <td class="num">${fmtUSD(p.low)}</td>
          <td class="num">${fmtUSD(p.market ?? p.mid)}</td>
          <td class="num">${fmtUSD(p.high)}</td>
        </tr>`).join("");
    }

    $("detailBody").innerHTML = `
      <img class="card-img" src="${card.images.large || card.images.small}" alt="${card.name}">
      <div class="detail-info">
        <h2>${card.name}</h2>
        <div class="meta">
          ${card.set.name} (${card.set.series}) · #${card.number}/${card.set.printedTotal || "?"} ·
          ${card.rarity || "Unknown rarity"} · Released ${card.set.releaseDate || "?"}
        </div>

        ${variantRows ? `
          <div class="section-title">Raw market prices — TCGPlayer (USD)${tcg.updatedAt ? ", updated " + tcg.updatedAt : ""}</div>
          <table>
            <tr><th>Variant</th><th class="num">Low</th><th class="num">Market</th><th class="num">High</th></tr>
            ${variantRows}
          </table>` : `<div class="section-title">No TCGPlayer price data for this card.</div>`}

        ${cm && cm.prices ? `
          <div class="section-title">Cardmarket (EUR)${cm.updatedAt ? ", updated " + cm.updatedAt : ""}</div>
          <table>
            <tr><th>Trend</th><th class="num">7-day avg</th><th class="num">30-day avg</th><th class="num">Low</th></tr>
            <tr>
              <td>${fmtEUR(cm.prices.trendPrice)}</td>
              <td class="num">${fmtEUR(cm.prices.avg7)}</td>
              <td class="num">${fmtEUR(cm.prices.avg30)}</td>
              <td class="num">${fmtEUR(cm.prices.lowPrice)}</td>
            </tr>
          </table>` : ""}

        <div id="gradedSection">
          <div class="loading-note">Loading graded prices…</div>
        </div>

        <div class="links">
          ${tcg && tcg.url ? `<a href="${tcg.url}" target="_blank" rel="noopener">TCGPlayer ↗</a>` : ""}
          ${cm && cm.url ? `<a href="${cm.url}" target="_blank" rel="noopener">Cardmarket ↗</a>` : ""}
          <a href="${ebaySoldLink(card, "")}" target="_blank" rel="noopener">eBay AU sold listings ↗</a>
          <a href="${priceChartingLink(card)}" target="_blank" rel="noopener">PriceCharting ↗</a>
          <a href="https://www.psacard.com/pop" target="_blank" rel="noopener">PSA pop report ↗</a>
        </div>
      </div>`;
    $("overlay").classList.add("open");
    fillGradedSection(card, raw);
  }

  $("closeDetail").addEventListener("click", () => $("overlay").classList.remove("open"));
  $("overlay").addEventListener("click", (e) => {
    if (e.target === $("overlay")) $("overlay").classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("overlay").classList.remove("open");
  });

  // ---------- Wire up ----------
  $("searchBtn").addEventListener("click", search);
  $("query").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  $("sort").addEventListener("change", () => { if (state.searchResults.length) search(); });

  loadSets();
  route();
})();
