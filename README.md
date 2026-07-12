# Pokémon Card Value Search

A single-file web app for quickly looking up Pokémon card values, including estimated
prices for different grades (PSA, BGS, CGC).

## What it does

- **Search any card** by name (e.g. `Charizard`), or name + card number (e.g. `Umbreon 197`)
- **Live raw market prices** from the free [Pokémon TCG API](https://pokemontcg.io):
  - TCGPlayer low / market / high in USD, per variant (holofoil, reverse holo, 1st edition, …)
  - Cardmarket trend, 7-day and 30-day averages in EUR
- **Estimated graded values** for PSA 10 / 9 / 8, BGS 9.5, CGC 10 / 9.5, calculated from
  the raw market price using multipliers you can customise in ⚙ Settings
- **One-click links to real sold prices** — every grade row links straight to eBay AU
  sold/completed listings for that exact card and grade, plus links to TCGPlayer,
  Cardmarket, PriceCharting and the PSA population report

## How to run it

No install, no build tools — it's one HTML file.

**Option 1 — open it directly:** download `index.html` and double-click it. That's it.

**Option 2 — host it free on GitHub Pages:**
1. In this repo on GitHub, go to **Settings → Pages**
2. Under "Build and deployment", set Source to **Deploy from a branch**, pick your branch
   and `/ (root)`, then save
3. Your site will be live at `https://<your-username>.github.io/pokemon/` in a minute or two —
   bookmark it on your phone and it works like an app

## Optional: free API key

The Pokémon TCG API works without a key but is rate-limited. If searches start failing,
grab a free key at [dev.pokemontcg.io](https://dev.pokemontcg.io) and paste it into
⚙ Settings — it's saved in your browser only.

## About the graded estimates

No free service publishes graded card prices, so the app estimates them as
`raw market price × multiplier`. The defaults (e.g. PSA 10 ≈ 4×) are rough,
era-dependent guides — vintage and low-population cards can be far higher, bulk modern
far lower. Adjust the multipliers in ⚙ Settings to suit what you collect, and always
check the eBay sold links (the real market) before buying or selling.
