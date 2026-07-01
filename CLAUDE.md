# White Knuckle City

A one-page statement site + live sports-tension tracker for Cleveland, Ohio sports fandom
(Guardians, Browns, Cavaliers). Tone: equal parts love letter and "here we go again" comedy.

## Live URLs
- Production (Cloudflare Pages): https://26475a52.white-knuckle-city.pages.dev
- Custom domain (in progress): https://whiteknucklecity.com  ← see "Custom domain" below
- Registrar: GoDaddy. DNS/zone: Cloudflare account bill.burkey@ememetics.com

## Stack / architecture
- Pure static site. No build step, no framework, no dependencies.
- `index.html` is self-contained: inline CSS + inline vanilla JS. Fonts via Google Fonts (Anton, Inter, Roboto Slab).
- Hosted on Cloudflare Pages, project name: `white-knuckle-city`, production branch: `production`.

## File structure
- `index.html` — the entire site (hero, definition, live index, moments timeline, merch, FAQ, footer).
- `robots.txt` — allows all crawlers incl. AI answer engines (GPTBot, PerplexityBot, ClaudeBot, etc.).
- `sitemap.xml` — single URL, references https://whiteknucklecity.com/.
- `assets/`
  - `og-image.png` — 1200x630 social share image.
  - `wordmark-print-dark.png` — print-ready wordmark, cream ink (for DARK garments). 3000x3000, transparent.
  - `wordmark-print-light.png` — print-ready wordmark, dark ink (for LIGHT garments). 3000x3000, transparent.
  - `wordmark-print.svg` — vector source of the wordmark (uses DejaVu Sans Condensed as a stand-in;
     swap to Anton in a design tool for brand-exact type).

## Deploy
From this folder, with wrangler authenticated to the ememetics Cloudflare account:
```bash
npx wrangler pages deploy . --project-name=white-knuckle-city
```
Uploads all files + /assets and returns a new *.pages.dev deployment URL.

## Custom domain (REMAINING — do this in a normal browser; the dashboard SPA hangs under automation)
`whiteknucklecity.com` currently returns Cloudflare error 525 (SSL handshake failed). Cause: the apex is
already proxied through Cloudflare but not yet attached to the Pages project, so there's no valid origin/cert.
Fix:
1. Cloudflare dashboard → Workers & Pages → `white-knuckle-city` → Custom domains → Set up a domain.
2. Enter `whiteknucklecity.com` (and optionally `www`). Let it REPLACE the conflicting apex DNS record.
3. Cloudflare auto-provisions the cert; 525 clears within a few minutes.
Note: `wrangler pages` has no reliable custom-domain subcommand — use the dashboard or the Cloudflare API.

## The White Knuckle Index (live meter)
- Client-side JS in `index.html` fetches ESPN public scoreboard endpoints (no API key) for:
  - MLB: /sports/baseball/mlb/scoreboard, NFL: /sports/football/nfl/scoreboard, NBA: /sports/basketball/nba/scoreboard
- Finds the Cleveland event (team abbreviation `CLE`), computes a 0–100 tension score from score-closeness
  and how late the game is, and drives the needle. Refreshes every 60s. Fails gracefully (no game / no network).
- These endpoints are CORS-open and run from the visitor's browser. They can change without notice — if the
  meter breaks, verify the ESPN response shape first.

## SEO / AEO
- Full meta + canonical, Open Graph, Twitter cards, theme-color.
- JSON-LD graph in <head>: WebSite + Organization + FAQPage (4 Q&As). Keep the visible FAQ section and the
  JSON-LD FAQPage answers in sync — the visible copy and the structured answers should match.

## Merch (REMAINING)
- Plan: print-on-demand via Printify. Upload `wordmark-print-dark.png` (dark garments) /
  `wordmark-print-light.png` (light garments) as the design; Printify generates real product photos.
- Site currently shows SVG cap + tee mockups with "Coming Soon" badges and a front-end-only email capture
  (`notifyMe()` just acknowledges — no backend yet). Wire real Printify product URLs into the buy buttons and
  connect the email field to a real list when ready.

## Open TODOs
1. Attach custom domain whiteknucklecity.com (see above) — highest priority.
2. Set up Printify products; replace "Coming Soon" with real buy links.
3. Give the email capture a real backend (e.g., a form service or Cloudflare Worker + KV/email).
4. Optional: richer live-index logic (win probability, not just score margin).
5. Optional: git init + connect Pages to a Git repo for auto-deploy on push (currently direct upload via wrangler).
