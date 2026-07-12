# Pokémon Card Value Search

A web app for looking up English Pokémon card values — search by name, browse
complete sets card-by-card, and see both raw market prices and real graded
prices (PSA / BGS / CGC / SGC).

## Features

- **Search any card** by name (e.g. `Charizard`) or name + number (e.g. `Umbreon 197`)
- **Browse sets** — every English set grouped by series; open one to see all its
  cards from #1 onwards in collector-number order, with images and prices
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
3. To enable real graded prices, subscribe to
   [PriceCharting's API](https://www.pricecharting.com/api-documentation) and copy
   your API token, then in Vercel go to your project's
   **Settings → Environment Variables** and add:
   - Name: `PRICECHARTING_TOKEN`
   - Value: *your token*
4. Redeploy (Deployments → ⋯ on the latest → Redeploy) so the variable takes effect

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

## Notes

- Card database is English-language cards only (that's all the Pokémon TCG API covers)
- The optional Pokémon TCG API key in ⚙ Settings raises that API's rate limit —
  free at [dev.pokemontcg.io](https://dev.pokemontcg.io). It's stored in the
  visitor's browser only.
- The PriceCharting token is **never** exposed to visitors — it lives in a Vercel
  environment variable and all calls go through `api/prices.js`
- Check PriceCharting's API terms regarding attribution when displaying their data publicly
