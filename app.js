(() => {
  "use strict";

  const DIRECT_API = "https://api.pokemontcg.io/v2/";
  // Only request the fields the app uses — cuts payloads by more than half.
  const CARD_FIELDS = "id,name,number,rarity,set,images,tcgplayer";
  const INITIAL_SERIES_SHOWN = 3;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const todayStr = () => new Date().toISOString().slice(0, 10);

  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    },
  };

  const state = {
    sets: [],
    searchResults: [],
    setCards: [],
    setCardsCache: new Map(),
    showAllSets: false,
    cardIndex: new Map(),      // id -> card, everything we've ever fetched
    fx: null,                  // { usdAud, eurAud, date }
    currentDetailId: null,
    returnHash: "",
    trendingCards: null,
    trendingSet: null,
    refreshing: false,
  };

  let collection = store.get("pcv-collection", {});        // id -> {qty, added, card}
  let collMeta = store.get("pcv-coll-meta", {});            // {lastRefresh}
  let priceHistory = store.get("pcv-history", {});          // id -> [{d, p}]
  let collHistory = store.get("pcv-coll-history", []);      // [{d, total}] in USD
  let recent = store.get("pcv-recent", []);                 // [card snapshots]
  let displayAUD = store.get("pcv-aud", false);

  function indexCards(cards) {
    for (const c of cards) if (c && c.id) state.cardIndex.set(c.id, c);
  }
  // Seed the index with saved snapshots so collection/recents render offline.
  indexCards(Object.values(collection).map(e => e.card));
  for (const c of recent) if (c && !state.cardIndex.has(c.id)) state.cardIndex.set(c.id, c);

  // ---------- API access (via our cached Vercel proxy, direct as fallback) ----------
  // backendAbsent is only set when there's genuinely no backend on this host
  // (e.g. the page was opened as a plain file) — never on a transient error,
  // so one slow upstream moment doesn't disable the proxy for the session.
  let backendAbsent = false;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  async function tcgFetch(path, params) {
    const qs = new URLSearchParams(params).toString();
    let lastErr;

    if (!backendAbsent) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(1000 * attempt);
        try {
          const res = await fetchWithTimeout("/api/tcg?path=" + path + (qs ? "&" + qs : ""), 30000);
          const ct = res.headers.get("content-type") || "";
          if (res.ok && ct.includes("json")) return res.json();
          if (res.status === 404 && !ct.includes("json")) {
            backendAbsent = true;
            break;
          }
          lastErr = new Error("server responded with " + res.status);
        } catch (err) {
          lastErr = err;
        }
      }
    }

    // Last resort: the API directly (also the normal path on static hosting).
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(1500);
      try {
        const res = await fetchWithTimeout(DIRECT_API + path + (qs ? "?" + qs : ""), 30000);
        if (res.ok) return res.json();
        lastErr = new Error("API responded with " + res.status);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("network error");
  }

  // ---------- Exchange rates ----------
  async function loadFx() {
    try {
      const res = await fetch("/api/fx");
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("json")) return;
      const j = await res.json();
      if (!j.available) return;
      state.fx = j;
      $("audWrap").hidden = false;
      $("audToggle").checked = displayAUD;
    } catch (err) { /* toggle stays hidden; prices stay in USD/EUR */ }
  }

  $("audToggle").addEventListener("change", () => {
    displayAUD = $("audToggle").checked;
    store.set("pcv-aud", displayAUD);
    refreshCurrentView();
  });

  // ---------- Formatting helpers ----------
  const money = (n) => n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function fmtUSD(n) {
    if (n == null) return "—";
    if (displayAUD && state.fx) return "≈A$" + money(n * state.fx.usdAud);
    return "US$" + money(n);
  }
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
           "&LH_Sold=1&LH_Complete=1&_sop=13";
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

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(iso) {
    const [, m, d] = iso.split("-");
    return parseInt(d, 10) + " " + MONTHS[parseInt(m, 10) - 1];
  }

  function setStatus(msg, isError) {
    $("status").textContent = msg || "";
    $("status").classList.toggle("error", !!isError);
  }

  function renderSkeletons(container, n) {
    container.innerHTML = Array.from({ length: n }, () =>
      `<div class="skeleton-tile"><div class="skeleton-img"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`
    ).join("");
  }

  // ---------- Price history (recorded on this device) ----------
  function recordPrice(card) {
    const p = bestMarketPrice(card);
    if (p == null) return;
    const arr = priceHistory[card.id] || [];
    const today = todayStr();
    if (arr.length && arr[arr.length - 1].d === today) {
      arr[arr.length - 1].p = p;
    } else {
      arr.push({ d: today, p });
    }
    if (arr.length > 400) arr.splice(0, arr.length - 400);
    priceHistory[card.id] = arr;
    store.set("pcv-history", priceHistory);
  }

  function recordCollHistory() {
    const entries = Object.values(collection);
    if (!entries.length) return;
    const total = collTotalUSD();
    const today = todayStr();
    if (collHistory.length && collHistory[collHistory.length - 1].d === today) {
      collHistory[collHistory.length - 1].total = total;
    } else {
      collHistory.push({ d: today, total });
    }
    if (collHistory.length > 730) collHistory.splice(0, collHistory.length - 730);
    store.set("pcv-coll-history", collHistory);
  }

  // ---------- Line chart (single series, hover tooltip) ----------
  function makeLineChart(container, points, valueFmt) {
    const W = 600, H = 180, padL = 12, padR = 12, padT = 20, padB = 26;
    const vs = points.map(p => p.v);
    let min = Math.min(...vs), max = Math.max(...vs);
    if (min === max) { min -= (Math.abs(min) * 0.05) + 1; max += (Math.abs(max) * 0.05) + 1; }
    const span = max - min;
    min -= span * 0.08; max += span * 0.08;

    const x = (i) => padL + i * (W - padL - padR) / Math.max(points.length - 1, 1);
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

    const coords = points.map((p, i) => [x(i), y(p.v)]);
    const linePath = coords.map(([cx, cy], i) => (i ? "L" : "M") + cx.toFixed(1) + " " + cy.toFixed(1)).join(" ");
    const areaPath = linePath + ` L ${coords[coords.length - 1][0].toFixed(1)} ${H - padB} L ${coords[0][0].toFixed(1)} ${H - padB} Z`;

    const grid = [0.25, 0.5, 0.75].map(f => {
      const gy = padT + f * (H - padT - padB);
      return `<line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" class="chart-grid"/>`;
    }).join("");

    const [ex, ey] = coords[coords.length - 1];
    const last = points[points.length - 1];
    const endLabelY = ey < padT + 16 ? ey + 16 : ey - 8;
    const endLabelAnchor = ex > W - 90 ? "end" : "middle";

    container.innerHTML = `
      <div class="chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="line-chart" role="img"
             aria-label="Price history chart, ${points.length} recorded days">
          ${grid}
          <path d="${areaPath}" class="chart-area"/>
          <path d="${linePath}" class="chart-line"/>
          <line class="chart-cursor" y1="${padT}" y2="${H - padB}" x1="0" x2="0" hidden/>
          <circle class="chart-cursor-dot" r="4" hidden/>
          <circle cx="${ex}" cy="${ey}" r="4" class="chart-end"/>
          <text x="${ex}" y="${endLabelY}" text-anchor="${endLabelAnchor}" class="chart-end-label">${valueFmt(last.v)}</text>
          <text x="${padL}" y="${padT - 8}" class="chart-axis-label">${valueFmt(max)}</text>
          <text x="${padL}" y="${H - padB + 14}" class="chart-axis-label">${valueFmt(min)}</text>
          <text x="${padL}" y="${H - 2}" class="chart-axis-label">${shortDate(points[0].d)}</text>
          <text x="${W - padR}" y="${H - 2}" text-anchor="end" class="chart-axis-label">${shortDate(last.d)}</text>
        </svg>
        <div class="chart-tip" hidden></div>
      </div>`;

    const wrap = container.querySelector(".chart-wrap");
    const svg = wrap.querySelector("svg");
    const cursor = svg.querySelector(".chart-cursor");
    const cursorDot = svg.querySelector(".chart-cursor-dot");
    const tip = wrap.querySelector(".chart-tip");

    function onMove(clientX) {
      const rect = svg.getBoundingClientRect();
      const relX = (clientX - rect.left) / rect.width * W;
      let idx = 0, bestDist = Infinity;
      coords.forEach(([cx], i) => {
        const d = Math.abs(cx - relX);
        if (d < bestDist) { bestDist = d; idx = i; }
      });
      const [cx, cy] = coords[idx];
      cursor.setAttribute("x1", cx); cursor.setAttribute("x2", cx); cursor.hidden = false;
      cursorDot.setAttribute("cx", cx); cursorDot.setAttribute("cy", cy); cursorDot.hidden = false;
      tip.hidden = false;
      tip.textContent = shortDate(points[idx].d) + " · " + valueFmt(points[idx].v);
      const pct = cx / W * 100;
      tip.style.left = Math.min(Math.max(pct, 12), 88) + "%";
    }
    function onLeave() { cursor.hidden = true; cursorDot.hidden = true; tip.hidden = true; }

    svg.addEventListener("mousemove", (e) => onMove(e.clientX));
    svg.addEventListener("mouseleave", onLeave);
    svg.addEventListener("touchstart", (e) => onMove(e.touches[0].clientX), { passive: true });
    svg.addEventListener("touchmove", (e) => onMove(e.touches[0].clientX), { passive: true });
    svg.addEventListener("touchend", onLeave);
  }

  // ---------- Views / routing ----------
  function showView(name) {
    $("homeView").hidden = name !== "home";
    $("setView").hidden = name !== "set";
    $("collectionView").hidden = name !== "collection";
  }

  function closeOverlay() {
    $("overlay").classList.remove("open");
    state.currentDetailId = null;
  }

  function route() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (h.startsWith("card=")) {
      openDetailById(h.slice(5));
      return;
    }
    closeOverlay();
    if (h.startsWith("set=")) {
      openSet(h.slice(4));
    } else if (h === "collection") {
      setStatus("");
      showView("collection");
      openCollection();
    } else {
      showView("home");
      if (!state.searchResults.length) setStatus("");
    }
  }
  window.addEventListener("hashchange", route);
  $("homeLink").addEventListener("click", () => { location.hash = ""; });

  function openCardLink(id) {
    if (!location.hash.startsWith("#card=")) state.returnHash = location.hash;
    location.hash = "card=" + id;
  }

  function refreshCurrentView() {
    if (!$("setView").hidden) {
      renderTiles($("setCards"), sortedSetCards());
    } else if (!$("collectionView").hidden) {
      renderCollection();
    } else {
      if (state.searchResults.length) renderTiles($("results"), state.searchResults);
      renderTrending();
      renderRecent();
    }
    if (state.currentDetailId) {
      const card = state.cardIndex.get(state.currentDetailId);
      if (card) renderDetail(card);
    }
  }

  // ---------- Set browser ----------
  async function loadSets() {
    try {
      const json = await tcgFetch("sets", { pageSize: 250, orderBy: "-releaseDate" });
      state.sets = json.data || [];
      renderSets();
      loadTrending();
      // If we landed directly on a #set= link before sets were ready, fill the header in now.
      const m = location.hash.match(/^#set=(.+)$/);
      if (m) renderSetHeader(decodeURIComponent(m[1]));
    } catch (err) {
      $("setsList").innerHTML =
        `<p class="sets-note">Couldn't load the set list (${err.message}). Refresh to retry.</p>`;
    }
  }

  function setTileHTML(s) {
    return `
      <div class="set-tile" data-set="${s.id}">
        <img src="${s.images.logo}" alt="${s.name}" loading="lazy">
        <div class="set-name">${s.name}</div>
        <div class="set-meta">${s.total} cards · ${s.releaseDate || ""}</div>
      </div>`;
  }

  function renderSets() {
    const filter = $("setSearch").value.trim().toLowerCase();
    const matching = filter
      ? state.sets.filter(s =>
          s.name.toLowerCase().includes(filter) || s.series.toLowerCase().includes(filter))
      : state.sets;

    if (!matching.length) {
      $("setsList").innerHTML = `<p class="sets-note">No sets match your search.</p>`;
      return;
    }

    const groups = [];
    for (const s of matching) {
      if (!groups.length || groups[groups.length - 1].series !== s.series) {
        groups.push({ series: s.series, sets: [] });
      }
      groups[groups.length - 1].sets.push(s);
    }

    const collapsed = !filter && !state.showAllSets && groups.length > INITIAL_SERIES_SHOWN;
    const visible = collapsed ? groups.slice(0, INITIAL_SERIES_SHOWN) : groups;

    let html = visible.map(g =>
      `<div class="series-title">${g.series}</div>
       <div class="sets-grid">${g.sets.map(setTileHTML).join("")}</div>`
    ).join("");

    if (collapsed) {
      const hiddenCount = groups.slice(INITIAL_SERIES_SHOWN).reduce((n, g) => n + g.sets.length, 0);
      html += `<div class="show-all-wrap">
        <button id="showAllSets" class="show-all-btn">Show all sets (${hiddenCount} more)</button>
      </div>`;
    }

    $("setsList").innerHTML = html;
    document.querySelectorAll(".set-tile").forEach(tile => {
      tile.addEventListener("click", () => { location.hash = "set=" + encodeURIComponent(tile.dataset.set); });
    });
    const showAll = $("showAllSets");
    if (showAll) showAll.addEventListener("click", () => { state.showAllSets = true; renderSets(); });
  }

  $("setSearch").addEventListener("input", renderSets);
  $("setSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = document.querySelector(".set-tile");
    if (first) location.hash = "set=" + encodeURIComponent(first.dataset.set);
  });

  async function fetchAllSetCards(setId) {
    if (state.setCardsCache.has(setId)) return state.setCardsCache.get(setId);
    const all = [];
    let page = 1;
    while (true) {
      const json = await tcgFetch("cards", {
        q: "set.id:" + setId, pageSize: 250, page, select: CARD_FIELDS,
      });
      all.push(...(json.data || []));
      if (!json.data || !json.data.length || all.length >= (json.totalCount || 0)) break;
      page++;
    }
    all.sort(byCollectorNumber);
    state.setCardsCache.set(setId, all);
    indexCards(all);
    return all;
  }

  function renderSetHeader(setId) {
    const set = state.sets.find(s => s.id === setId);
    $("setHeader").innerHTML = set ? `
      <img src="${set.images.logo}" alt="${set.name}">
      <div class="set-header-text">
        <h2>${set.name}</h2>
        <p>${set.series} · ${set.total} cards · Released ${set.releaseDate || "?"}</p>
      </div>` : "";
  }

  function sortedSetCards() {
    const cards = state.setCards.slice();
    const mode = $("setSort").value;
    if (mode === "number-asc") cards.sort(byCollectorNumber);
    else if (mode === "number-desc") cards.sort((a, b) => byCollectorNumber(b, a));
    else if (mode === "price-desc") cards.sort((a, b) => (bestMarketPrice(b) ?? -1) - (bestMarketPrice(a) ?? -1));
    else if (mode === "price-asc") cards.sort((a, b) => (bestMarketPrice(a) ?? Infinity) - (bestMarketPrice(b) ?? Infinity));
    return cards;
  }

  $("setSort").addEventListener("change", () => {
    if (state.setCards.length) renderTiles($("setCards"), sortedSetCards());
  });

  async function openSet(setId) {
    showView("set");
    renderSetHeader(setId);
    renderSkeletons($("setCards"), 12);

    setStatus("Loading cards…");
    try {
      const cards = await fetchAllSetCards(setId);
      state.setCards = cards;
      setStatus(`${cards.length} cards. Tap a card for prices.`);
      renderTiles($("setCards"), sortedSetCards());
    } catch (err) {
      $("setCards").innerHTML = "";
      setStatus("Couldn't load this set (" + err.message + "). Go back and try again.", true);
    }
  }

  // ---------- Search ----------
  async function search() {
    const raw = $("query").value.trim();
    if (!raw) return;
    location.hash = "";
    showView("home");

    const numMatch = raw.match(/^(.*?)\s+(\d{1,3})$/);
    let q;
    if (numMatch && numMatch[1].trim()) {
      q = `name:"${numMatch[1].trim()}*" number:${numMatch[2]}`;
    } else {
      q = `name:"${raw}*"`;
    }

    setStatus("Searching…");
    renderSkeletons($("results"), 6);

    const sortVal = $("sort").value;
    // The API can't sort by price server-side, so for the price sort we fetch
    // a big page and order it here instead.
    const orderBy = sortVal === "price" ? "-set.releaseDate" : sortVal;

    try {
      const json = await tcgFetch("cards", {
        q, orderBy, pageSize: 250, select: CARD_FIELDS,
      });
      let cards = json.data || [];
      if (!cards.length) {
        state.searchResults = [];
        $("results").innerHTML = "";
        setStatus(`No cards found for “${raw}”. Try a shorter name (e.g. just “Charizard”).`);
        return;
      }
      if (sortVal === "price") {
        cards = cards.slice().sort((a, b) => (bestMarketPrice(b) ?? -1) - (bestMarketPrice(a) ?? -1));
      }
      indexCards(cards);
      state.searchResults = cards;
      const total = json.totalCount ?? cards.length;
      setStatus(total > cards.length
        ? `${total} cards found — showing the ${cards.length} most recent. Add a word to narrow it down.`
        : `${total} card(s) found. Tap a card for prices.`);
      renderTiles($("results"), cards);
    } catch (err) {
      $("results").innerHTML = "";
      setStatus(
        "The card database is having a slow moment and didn't answer after several tries — " +
        "tap Search again in a few seconds.", true);
    }
  }

  // ---------- Tile rendering ----------
  function tilePriceText(card) {
    const p = bestMarketPrice(card);
    return p != null ? fmtUSD(p) + " raw" : "no price data";
  }

  function cardTileHTML(c) {
    return `
      <div class="card-tile" data-id="${c.id}" tabindex="0" role="button">
        <img src="${c.images.small}" alt="${c.name}" loading="lazy">
        <div class="name">${c.name}</div>
        <div class="set">${c.set.name} · ${c.number}/${c.set.printedTotal || "?"} · ${c.rarity || "—"}</div>
        <div class="price">${tilePriceText(c)}</div>
      </div>`;
  }

  function renderTiles(container, cards) {
    container.innerHTML = cards.map(cardTileHTML).join("");
    wireCardTiles(container);
  }

  function wireCardTiles(container) {
    container.querySelectorAll(".card-tile").forEach(tile => {
      tile.addEventListener("click", () => openCardLink(tile.dataset.id));
      tile.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCardLink(tile.dataset.id); }
      });
    });
  }

  function miniTileHTML(c) {
    const price = bestMarketPrice(c);
    return `
      <div class="mini-tile card-tile" data-id="${c.id}" tabindex="0" role="button">
        <img src="${c.images.small}" alt="${c.name}" loading="lazy">
        <div class="name">${c.name}</div>
        <div class="price">${price != null ? fmtUSD(price) : ""}</div>
      </div>`;
  }

  function renderMiniRow(container, cards) {
    container.innerHTML = cards.map(miniTileHTML).join("");
    wireCardTiles(container);
  }

  // ---------- Trending & recently viewed ----------
  async function loadTrending() {
    for (const s of state.sets.slice(0, 4)) {
      try {
        const cards = await fetchAllSetCards(s.id);
        const top = cards
          .filter(c => bestMarketPrice(c) != null)
          .sort((a, b) => bestMarketPrice(b) - bestMarketPrice(a))
          .slice(0, 10);
        if (top.length >= 4) {
          state.trendingCards = top;
          state.trendingSet = s;
          renderTrending();
          return;
        }
      } catch (err) { /* try the next set */ }
    }
  }

  function renderTrending() {
    if (!state.trendingCards) return;
    $("trendingTitle").textContent = "Hot right now — " + state.trendingSet.name + " top cards";
    renderMiniRow($("trendingRow"), state.trendingCards);
    $("trendingSection").hidden = false;
  }

  function pushRecent(card) {
    recent = [card, ...recent.filter(c => c.id !== card.id)].slice(0, 10);
    store.set("pcv-recent", recent);
    renderRecent();
  }

  function renderRecent() {
    if (!recent.length) { $("recentSection").hidden = true; return; }
    renderMiniRow($("recentRow"), recent);
    $("recentSection").hidden = false;
  }

  // ---------- Collection ----------
  function collCount() {
    return Object.values(collection).reduce((n, e) => n + e.qty, 0);
  }
  function collTotalUSD() {
    return Object.values(collection).reduce((sum, e) => {
      const p = bestMarketPrice(e.card);
      return sum + (p != null ? p * e.qty : 0);
    }, 0);
  }
  function updateCollBadge() {
    $("collCount").textContent = collCount();
  }
  function saveColl() {
    store.set("pcv-collection", collection);
    updateCollBadge();
    recordCollHistory();
  }

  function addToCollection(card) {
    if (collection[card.id]) collection[card.id].qty++;
    else collection[card.id] = { qty: 1, added: todayStr(), card };
    recordPrice(card);
    saveColl();
  }
  function changeQty(id, delta) {
    const entry = collection[id];
    if (!entry) return;
    entry.qty = Math.max(1, entry.qty + delta);
    saveColl();
  }
  function removeFromCollection(id) {
    delete collection[id];
    saveColl();
  }

  function openCollection() {
    renderCollection();
    const entries = Object.values(collection);
    const stale = !collMeta.lastRefresh || (Date.now() - collMeta.lastRefresh > DAY_MS);
    if (entries.length && stale && !state.refreshing) refreshCollectionPrices();
  }

  function renderCollection() {
    const entries = Object.values(collection)
      .sort((a, b) => (b.added || "").localeCompare(a.added || ""));
    updateCollBadge();

    if (!entries.length) {
      $("collSummary").innerHTML = "";
      $("collChart").innerHTML = "";
      $("collCards").innerHTML = "";
      $("collEmpty").hidden = false;
      return;
    }
    $("collEmpty").hidden = true;

    const updated = collMeta.lastRefresh
      ? new Date(collMeta.lastRefresh).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
      : "not yet";
    $("collSummary").innerHTML = `
      <div class="coll-stats">
        <div class="stat">
          <div class="stat-label">Collection value (raw)</div>
          <div class="stat-value">${fmtUSD(collTotalUSD())}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Cards</div>
          <div class="stat-value">${entries.length}<span class="stat-sub"> unique · ${collCount()} total</span></div>
        </div>
        <div class="stat stat-action">
          <button id="refreshColl" class="show-all-btn" ${state.refreshing ? "disabled" : ""}>
            ${state.refreshing ? "Refreshing…" : "Refresh prices"}
          </button>
          <div class="stat-label">Prices updated: ${updated}</div>
        </div>
      </div>`;
    const btn = $("refreshColl");
    if (btn) btn.addEventListener("click", () => refreshCollectionPrices());

    if (collHistory.length >= 2) {
      $("collChart").innerHTML = `<h2 class="row-title">Collection value over time</h2><div id="collChartBody"></div>`;
      makeLineChart($("collChartBody"), collHistory.map(h => ({ d: h.d, v: h.total })), fmtUSD);
    } else {
      $("collChart").innerHTML =
        `<p class="sets-note">Value history starts recording from today — open the app tomorrow and a chart will appear here.</p>`;
    }

    $("collCards").innerHTML = entries.map(e => {
      const c = e.card;
      const p = bestMarketPrice(c);
      const lineValue = p != null && e.qty > 1 ? ` × ${e.qty} = ${fmtUSD(p * e.qty)}` : "";
      return `
        <div class="card-tile" data-id="${c.id}" tabindex="0" role="button">
          <img src="${c.images.small}" alt="${c.name}" loading="lazy">
          <div class="name">${c.name}</div>
          <div class="set">${c.set.name} · ${c.number}/${c.set.printedTotal || "?"}</div>
          <div class="price">${p != null ? fmtUSD(p) + lineValue : "no price data"}</div>
          <div class="qty-row">
            <button class="qty-btn" data-act="dec" aria-label="Decrease quantity">−</button>
            <span class="qty-num">${e.qty}</span>
            <button class="qty-btn" data-act="inc" aria-label="Increase quantity">+</button>
            <button class="qty-btn rm" data-act="rm" aria-label="Remove from collection">✕</button>
          </div>
        </div>`;
    }).join("");

    $("collCards").querySelectorAll(".card-tile").forEach(tile => {
      const id = tile.dataset.id;
      tile.addEventListener("click", (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        if (act === "inc") { changeQty(id, 1); renderCollection(); }
        else if (act === "dec") { changeQty(id, -1); renderCollection(); }
        else if (act === "rm") { removeFromCollection(id); renderCollection(); }
        else openCardLink(id);
      });
    });
  }

  async function refreshCollectionPrices() {
    const ids = Object.keys(collection);
    if (!ids.length || state.refreshing) return;
    state.refreshing = true;
    renderCollection();
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const q = "(" + chunk.map(id => "id:" + id).join(" OR ") + ")";
        const json = await tcgFetch("cards", { q, pageSize: 250, select: CARD_FIELDS });
        for (const fresh of (json.data || [])) {
          if (collection[fresh.id]) {
            collection[fresh.id].card = fresh;
            recordPrice(fresh);
          }
        }
        indexCards(json.data || []);
      }
      collMeta.lastRefresh = Date.now();
      store.set("pcv-coll-meta", collMeta);
      saveColl();
    } catch (err) {
      setStatus("Couldn't refresh prices (" + err.message + "). Showing last known values.", true);
    }
    state.refreshing = false;
    if (!$("collectionView").hidden) renderCollection();
  }

  $("emptyBrowse").addEventListener("click", () => { location.hash = ""; });

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

  function noGradedHTML(card, note) {
    return `
      <div class="section-title">Graded prices</div>
      <div class="disclaimer">${note}</div>
      <div class="links">
        <a href="${ebaySoldLink(card, "PSA 9")}" target="_blank" rel="noopener">PSA 9 sold ↗</a>
        <a href="${ebaySoldLink(card, "PSA 10")}" target="_blank" rel="noopener">PSA 10 sold ↗</a>
        <a href="${ebaySoldLink(card, "CGC")}" target="_blank" rel="noopener">CGC sold ↗</a>
      </div>`;
  }

  function gradedTableHTML(card, data) {
    const p = data.prices;
    const rows = [
      ["Ungraded", p.ungraded, ""],
      ["Grade 7", p.grade7, "PSA 7"],
      ["Grade 8", p.grade8, "PSA 8"],
      ["Grade 9 (PSA 9)", p.grade9, "PSA 9"],
      ["Grade 9.5", p.grade95, "9.5"],
      ["PSA 10", p.psa10, "PSA 10"],
      ["BGS 10", p.bgs10, "BGS 10"],
      ["CGC 10", p.cgc10, "CGC 10"],
      ["SGC 10", p.sgc10, "SGC 10"],
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

  async function fillGradedSection(card) {
    const el = $("gradedSection");
    if (!el) return;
    try {
      const data = await fetchGradedPrices(card);
      if (!data.configured) {
        el.innerHTML = noGradedHTML(card,
          "Live graded prices aren't set up yet (add a PriceCharting token on Vercel). Check recent graded sales on eBay:");
        return;
      }
      if (!data.found) {
        el.innerHTML = noGradedHTML(card,
          "PriceCharting doesn't have this card yet. Check recent graded sales on eBay:");
        return;
      }
      const table = gradedTableHTML(card, data);
      el.innerHTML = table || noGradedHTML(card,
        "PriceCharting matched this card but has no recorded prices yet. Check recent graded sales on eBay:");
    } catch (err) {
      el.innerHTML = noGradedHTML(card,
        "Couldn't load graded prices just now — reopen the card to retry, or check eBay:");
    }
  }

  // ---------- Detail view ----------
  async function openDetailById(id) {
    let card = state.cardIndex.get(id);
    if (!card) {
      setStatus("Loading card…");
      try {
        const json = await tcgFetch("cards", { q: "id:" + id, pageSize: 1, select: CARD_FIELDS });
        card = json.data && json.data[0];
        if (card) indexCards([card]);
      } catch (err) { /* handled below */ }
      setStatus("");
      if (!card) {
        setStatus("Couldn't find that card — the link may be wrong.", true);
        location.hash = "";
        return;
      }
    }
    const firstOpen = state.currentDetailId !== id;
    renderDetail(card);
    state.currentDetailId = id;
    if (firstOpen) {
      recordPrice(card);
      pushRecent(card);
    }
  }

  function renderCollControls(card) {
    const el = $("collControls");
    if (!el) return;
    const entry = collection[card.id];
    if (!entry) {
      el.innerHTML = `<button class="coll-btn" id="collAdd">♡ Add to collection</button>`;
      $("collAdd").addEventListener("click", () => { addToCollection(card); renderCollControls(card); });
      return;
    }
    el.innerHTML = `
      <div class="coll-inline">
        <span class="in-coll">✓ In collection</span>
        <span class="qty-stepper">
          <button class="qty-btn" data-q="-1" aria-label="Decrease quantity">−</button>
          <span class="qty-num">${entry.qty}</span>
          <button class="qty-btn" data-q="1" aria-label="Increase quantity">+</button>
        </span>
        <button class="qty-btn rm" id="collRemove">Remove</button>
      </div>`;
    el.querySelectorAll("[data-q]").forEach(b =>
      b.addEventListener("click", () => { changeQty(card.id, parseInt(b.dataset.q, 10)); renderCollControls(card); }));
    $("collRemove").addEventListener("click", () => { removeFromCollection(card.id); renderCollControls(card); });
  }

  function renderHistorySection(card) {
    const el = $("historySection");
    if (!el) return;
    const arr = priceHistory[card.id] || [];
    if (arr.length < 2) {
      el.innerHTML = `<div class="disclaimer">Price history builds up as you use the app —
        this card has ${arr.length || "no"} recorded day${arr.length === 1 ? "" : "s"} so far (recorded on this device).</div>`;
      return;
    }
    el.innerHTML = `<div class="section-title">Raw price history (recorded on this device)</div><div id="historyChart"></div>`;
    makeLineChart($("historyChart"), arr.map(x => ({ d: x.d, v: x.p })), fmtUSD);
  }

  function renderDetail(card) {
    const tcg = card.tcgplayer;

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

        <div id="collControls"></div>

        ${variantRows ? `
          <div class="section-title">Raw market prices — TCGPlayer (USD)${tcg.updatedAt ? ", updated " + tcg.updatedAt : ""}</div>
          <table>
            <tr><th>Variant</th><th class="num">Low</th><th class="num">Market</th><th class="num">High</th></tr>
            ${variantRows}
          </table>` : `<div class="section-title">No TCGPlayer price data for this card.</div>`}

        <div id="gradedSection">
          <div class="loading-note">Loading graded prices…</div>
        </div>

        <div id="historySection"></div>

        <div class="links">
          <a href="#" id="copyLink">Copy share link</a>
          ${tcg && tcg.url ? `<a href="${tcg.url}" target="_blank" rel="noopener">TCGPlayer ↗</a>` : ""}
          <a href="${ebaySoldLink(card, "")}" target="_blank" rel="noopener">eBay AU sold listings ↗</a>
          <a href="${priceChartingLink(card)}" target="_blank" rel="noopener">PriceCharting ↗</a>
          <a href="https://www.psacard.com/pop" target="_blank" rel="noopener">PSA pop report ↗</a>
        </div>
      </div>`;
    $("overlay").classList.add("open");

    renderCollControls(card);
    renderHistorySection(card);
    fillGradedSection(card);

    $("copyLink").addEventListener("click", async (e) => {
      e.preventDefault();
      const url = location.origin + location.pathname + "#card=" + card.id;
      try {
        if (navigator.share) {
          await navigator.share({ title: card.name + " — Pokémon Card Value", url });
        } else {
          await navigator.clipboard.writeText(url);
          e.target.textContent = "Link copied ✓";
          setTimeout(() => { e.target.textContent = "Copy share link"; }, 2000);
        }
      } catch (err) { /* user cancelled the share sheet */ }
    });
  }

  function requestCloseDetail() {
    if (location.hash.startsWith("#card=")) {
      location.hash = state.returnHash && !state.returnHash.startsWith("#card=")
        ? state.returnHash.replace(/^#/, "")
        : "";
    } else {
      closeOverlay();
    }
  }

  $("closeDetail").addEventListener("click", requestCloseDetail);
  $("overlay").addEventListener("click", (e) => {
    if (e.target === $("overlay")) requestCloseDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("overlay").classList.contains("open")) requestCloseDetail();
  });

  // ---------- Wire up ----------
  $("searchBtn").addEventListener("click", search);
  $("query").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  $("sort").addEventListener("change", () => { if (state.searchResults.length) search(); });

  updateCollBadge();
  recordCollHistory();     // one value point per day the app is opened
  renderRecent();
  loadFx();
  loadSets();
  route();
})();
