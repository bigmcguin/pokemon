# Pokémon Card Value Search

A web app for looking up English Pokémon card values — search by name, browse
complete sets card-by-card, and see both raw market prices and real graded
prices (PSA / BGS / CGC / SGC).

## Features

- **Search any card** by name (e.g. `Charizard`) or name + number (e.g. `Umbreon 197`),
  sortable by price, newest, oldest or name
- **Browse sets** — every English set grouped by series (newest three series shown
  first, with a "Show all sets" button), with a set-search box that filters as you
  type; open a set to see all its cards from #1 onwards in collector-number order
- **Raw market prices** from the free [Pokémon TCG API](https://pokemontcg.io):
  TCGPlayer low/market/high (USD) per variant
- **Real graded prices** from [PriceCharting](https://www.pricecharting.com)
  (Ungraded, Grades 7–9.5, PSA 10, BGS 10, CGC 10, SGC 10) via a small backend that
  keeps the paid API token secret and caches results for 24 hours. When a grade has
  no recorded data, the app links straight to eBay sold listings instead of guessing.
- **Set sorting** — order any set by card number (either direction) or value
  (high→low / low→high)
- **One-click reality checks** — every grade links to eBay AU sold listings for
  that exact card and grade
- **My collection** — add cards with quantities; see total value, a value-over-time
  chart, and refresh all prices in one tap (auto-refreshes daily). Stored in the
  browser on your device.
- **AUD display toggle** — show all prices in approximate Australian dollars using
  daily ECB exchange rates
- **Shareable card links** — every card has its own URL (`…#card=sv8-130`); a
  "Copy share link" button uses the native share sheet on phones
- **Home page rows** — top-value cards from the latest set, plus your recently
  viewed cards
- **Price history** — the app records a daily price point for cards you view or
  collect (on your device) and charts them once there are two or more days of data

## Deploying on Vercel

1. Go to [vercel.com](https://vercel.com), sign up (free) with your GitHub account
2. Click **Add New → Project** and import the `pokemon` repository, then **Deploy**
   (no build settings needed — Vercel auto-detects everything)
3. In Vercel, go to the project's **Settings → Environment Variables** and add:
   - `PRICECHARTING_TOKEN` — your [PriceCharting API](https://www.pricecharting.com/api-documentation)
     token (paid sub), enables real graded prices
   - `POKEMONTCG_API_KEY` — your free [dev.pokemontcg.io](https://dev.pokemontcg.io)
     key (optional), raises the card database's rate limit
4. Redeploy (Deployments → ⋯ on the latest → Redeploy) so the variables take effect

Your site is live at `https://<project>.vercel.app` — open it on your phone and
use "Add to Home Screen" for an app-like icon.

Without the token everything still works; the graded section just links to eBay
sold listings instead of showing PriceCharting data.

## Optional: daily price-guide import (recommended)

Instead of per-card API lookups, the app can import PriceCharting's full Pokémon
price guide (a premium CSV download) into a free Postgres database once a day.
Graded prices then come from the database — complete data, instant, no API rate
limits. Setup:

1. In Vercel: project → **Storage** tab → **Create Database** → **Neon (Postgres)**,
   free plan, and connect it to this project (this adds a `DATABASE_URL` env var)
2. Add an env var `CRON_SECRET` set to any long random string
3. Redeploy, then run the first import by visiting
   `https://<your-app>.vercel.app/api/refresh-guide?secret=<your CRON_SECRET>`
   (takes a minute or two; responds with the imported row count)
4. Done — a Vercel cron re-imports daily at 18:00 UTC (4 am AEST)

If the import complains about the CSV URL, log in to PriceCharting, copy the
Pokémon CSV link from their price-guide download page, and set it as a
`PRICECHARTING_CSV_URL` env var.

The card view still falls back to the live API (rate-limited to 1 req/s) for
anything the guide doesn't cover, so the database is strictly optional.

## Project layout

| File | Purpose |
|---|---|
| `index.html` | Page shell |
| `styles.css` | Styling |
| `app.js` | Search, set browser, card detail, settings |
| `api/prices.js` | Vercel serverless function — PriceCharting proxy with 24 h edge caching |
| `api/tcg.js` | Vercel serverless function — cached proxy for the Pokémon TCG API (6–24 h) |
| `api/fx.js` | Vercel serverless function — daily USD/EUR→AUD rates (Frankfurter/ECB) |
| `api/refresh-guide.js` | Daily cron — imports PriceCharting's Pokémon price-guide CSV into Postgres |
| `lib/` | Shared helpers (CSV parsing, database connection) |
| `.claude/skills/` | Design skills used by Claude Code when working on this repo |

## Notes

- Card database is English-language cards only (that's all the Pokémon TCG API covers)
- Both API keys live in Vercel environment variables and are **never** exposed to
  visitors — all upstream calls go through the two `api/` functions
- Edge caching means repeat views of any set, search or card cost little to no
  upstream API quota and load near-instantly
- Check PriceCharting's API terms regarding attribution when displaying their data publicly
