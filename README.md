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
  TCGPlayer low/market/high (USD) per variant, plus Cardmarket trend and averages (EUR)
- **Real graded prices** from [PriceCharting](https://www.pricecharting.com)
  (Ungraded, Grade 9, 9.5, PSA 10, BGS 10, CGC 10, SGC 10) via a small backend that
  keeps the paid API token secret and caches results for 24 hours. If the token
  isn't configured (or a card has no match), the app falls back to multiplier-based
  estimates you can tune in ⚙ Settings.
- **One-click reality checks** — every grade links to eBay AU sold listings for
  that exact card and grade

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

Without the token everything still works; the graded table just shows estimates
instead of live PriceCharting data.

## Project layout

| File | Purpose |
|---|---|
| `index.html` | Page shell |
| `styles.css` | Styling |
| `app.js` | Search, set browser, card detail, settings |
| `api/prices.js` | Vercel serverless function — PriceCharting proxy with 24 h edge caching |
| `api/tcg.js` | Vercel serverless function — cached proxy for the Pokémon TCG API (6–24 h) |

## Notes

- Card database is English-language cards only (that's all the Pokémon TCG API covers)
- Both API keys live in Vercel environment variables and are **never** exposed to
  visitors — all upstream calls go through the two `api/` functions
- Edge caching means repeat views of any set, search or card cost little to no
  upstream API quota and load near-instantly
- Check PriceCharting's API terms regarding attribution when displaying their data publicly
