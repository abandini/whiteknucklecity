# White Knuckle City

A one-page statement site + live sports-tension tracker for Cleveland, Ohio sports fandom
(Guardians, Browns, Cavaliers). Tone: equal parts love letter and "here we go again" comedy.

## Live URLs
- Production (Cloudflare Worker): https://white-knuckle-city.bill-burkey.workers.dev
- Custom domain (in progress): https://whiteknucklecity.com  ← see "Custom domain" below
- Registrar: GoDaddy. DNS/zone: Cloudflare account bill.burkey@ememetics.com

## Stack / architecture
- **Cloudflare Worker with static assets** (migrated from Pages — Cloudflare now steers new
  projects to Workers). No framework, no build step, no runtime dependencies.
- `public/` — the static site (served by the `[assets]` binding).
- `src/index.js` — the Worker. Serves assets for everything except `POST /api/notify`,
  which it handles (merch signup → Resend). Unmatched paths get the branded `public/404.html`.
- `wrangler.toml` — Worker config (`main`, `compatibility_date`, `[assets]` binding + `not_found_handling`).
- Fonts via Google Fonts (Anton, Inter, Roboto Slab).

## File structure
- `public/`
  - `index.html` — the entire site (hero, definition, live index, moments timeline, merch, FAQ, footer).
  - `404.html` — branded not-found page.
  - `robots.txt` — allows all crawlers incl. AI answer engines (GPTBot, PerplexityBot, ClaudeBot, etc.).
  - `sitemap.xml` — single URL.
  - `site.webmanifest` — PWA-lite manifest (icons, theme color).
  - `llms.txt` — plain-language site summary for AI answer engines (AEO).
  - `assets/`
    - `og-image.png` — 1200x630 social share image.
    - `favicon.svg` + `favicon-32.png` + `icon-180/192/512.png` — favicons / touch icon / manifest icons
      (rendered from `favicon.svg` with rsvg-convert).
    - `wordmark-print-dark.png` — print-ready wordmark, cream ink (for DARK garments). 3000x3000, transparent.
    - `wordmark-print-light.png` — print-ready wordmark, dark ink (for LIGHT garments). 3000x3000, transparent.
    - `wordmark-print.svg` — vector source of the wordmark (DejaVu Sans Condensed stand-in; swap to Anton for brand-exact type).
- `src/index.js` — Worker fetch handler.
- `wrangler.toml` — Worker config.

## Deploy
From this folder, with wrangler authenticated to the ememetics Cloudflare account:
```bash
npx wrangler deploy
```
Uploads `src/index.js` + everything in `public/` and returns the workers.dev URL.

### Secrets
`RESEND_API_KEY` is stored as a Worker secret (NEVER committed):
```bash
printf '%s' "re_..." | npx wrangler secret put RESEND_API_KEY
```
The key was shared in plaintext during setup — consider rotating it in the Resend dashboard.

## Custom domain (REMAINING — do this in a normal browser; the dashboard SPA hangs under automation)
`whiteknucklecity.com` currently returns Cloudflare error 525 (SSL handshake failed): the apex is
proxied through Cloudflare but not attached to a service, so there's no valid origin/cert.
Fix:
1. Cloudflare dashboard → Workers & Pages → `white-knuckle-city` (Worker) → Settings → Domains & Routes → Add custom domain.
2. Enter `whiteknucklecity.com` (and optionally `www`). Let it REPLACE the conflicting apex DNS record.
3. Cloudflare auto-provisions the cert; 525 clears within a few minutes.
4. Then swap every `white-knuckle-city.bill-burkey.workers.dev` back to `https://whiteknucklecity.com/`:
   `public/index.html` (canonical, hreflang, OG/Twitter, JSON-LD urls), `public/sitemap.xml`,
   `public/robots.txt`, `public/llms.txt`, and `SITE` in `src/index.js`. Redeploy.

## The White Knuckle Index (live meter)
- Client-side JS in `public/index.html` fetches ESPN public scoreboard endpoints (no API key) for:
  - MLB: /sports/baseball/mlb/scoreboard, NFL: /sports/football/nfl/scoreboard, NBA: /sports/basketball/nba/scoreboard
- Finds the Cleveland event (team abbreviation `CLE`), computes a 0–100 tension score from score-closeness
  and how late the game is, drives the needle. Refreshes every 60s. Fails gracefully (no game / no network).
- ESPN strings that hit `innerHTML` are HTML-escaped via `esc()` (defense against third-party markup).
- The meter exposes `role="meter"` + `aria-live` so screen readers hear updates. Animations respect
  `prefers-reduced-motion`.
- These endpoints are CORS-open and run from the visitor's browser. They can change without notice — if the
  meter breaks, verify the ESPN response shape first.

## SEO / AEO
- Full meta + canonical + hreflang, Open Graph (with image alt/type), Twitter cards, theme-color, geo tags.
- Rich JSON-LD `@graph`: WebSite + Organization + WebPage (with `speakable`) + ImageObject +
  3× SportsTeam (with `sameAs`) + ItemList (the 9 timeline moments) + FAQPage (4 Q&As).
- `robots.txt` welcomes AI crawlers; `sitemap.xml` + `llms.txt` present.
- Keep the visible FAQ section and the JSON-LD FAQPage answers in sync.
- `@id` values intentionally use the final `whiteknucklecity.com` domain (stable identifiers);
  `url`/`image`/`logo` values use the live workers.dev URL until the custom domain is attached.

## Merch signup (WIRED)
- `POST /api/notify` (in `src/index.js`) validates the email, adds it to the Resend audience
  **"White Knuckle City"** (id `9b31482a-1a9e-4a12-85d1-b911bbf24aa9`), and sends a branded confirmation
  from `noreply@whiteknucklecity.com` (domain verified in Resend). The front-end only shows success when the
  server confirms. To broadcast when merch drops, use a Resend Broadcast to that audience.

## Merch products (REMAINING)
- Plan: print-on-demand via Printify. Upload `wordmark-print-dark.png` (dark garments) /
  `wordmark-print-light.png` (light garments) as the design; Printify generates real product photos.
- Site shows SVG cap + tee mockups with "Coming Soon" badges. Wire real Printify product URLs into the buy buttons.

## Open TODOs
1. Attach custom domain whiteknucklecity.com to the Worker (see above) — highest priority.
2. Set up Printify products; replace "Coming Soon" with real buy links.
3. Optional: richer live-index logic (win probability, not just score margin).
4. Optional: rotate the Resend API key (was shared in plaintext during setup).
5. Optional: delete the now-unused `white-knuckle-city` **Pages** project (the earlier deploy) to avoid a duplicate live copy at `*.pages.dev`.
