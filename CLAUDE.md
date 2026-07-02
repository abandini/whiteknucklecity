# White Knuckle City

A one-page statement site + live sports-tension tracker for Cleveland, Ohio sports fandom
(Guardians, Browns, Cavaliers). Tone: equal parts love letter and "here we go again" comedy.

## Live URLs
- Production (Cloudflare Worker): https://whiteknucklecity.com  (also www.whiteknucklecity.com)
- workers.dev URL is intentionally disabled (custom domain is the single canonical home).
- Registrar: GoDaddy. DNS/zone: Cloudflare account bill.burkey@ememetics.com (zone 84c8d30bbd82ee2afa0d6e2a50e86119).

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

## Edge behavior (src/index.js — requires `run_worker_first = true` in wrangler.toml)
Static-asset requests bypass the Worker unless `run_worker_first` is set — without it the
redirects/headers silently stop working. The Worker adds:
- 301 http→https and www→apex (single canonical origin; zone-level "Always Use HTTPS" not needed).
- Security headers: HSTS, CSP (allows Google Fonts, ESPN, and the zone's auto-injected
  Cloudflare Web Analytics beacon), nosniff, referrer-policy, permissions-policy.
- `/assets/*` cached `max-age=86400` (filenames aren't hashed — don't go immutable).
- `/api/notify` protections: 5 req / 10 min / IP via `caches.default` (best-effort, per-colo),
  and duplicate signups return `{ok,duplicate:true}` WITHOUT re-sending the confirmation email
  (Resend contact-create is idempotent-201, so duplicates are detected via GET-by-email first).

## Custom domain (DONE)
`whiteknucklecity.com` + `www` are attached to the Worker via the `routes` block in `wrangler.toml`
(`custom_domain = true`), so `wrangler deploy` provisions the managed DNS records + certs. The old
525 was caused by two proxied apex A records (GoDaddy parking IPs) — those and the old `www` CNAME
were deleted; the Resend email records (MX/DKIM/SPF/DMARC) were left intact. All URLs point at the
apex. If you ever move again, this is the swap list: `public/index.html`, `public/sitemap.xml`,
`public/robots.txt`, `public/llms.txt`, and `SITE` in `src/index.js`.

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
1. Set up Printify products; replace "Coming Soon" with real buy links.
2. Optional: richer live-index logic (win probability, not just score margin).
3. Optional: rotate the Resend API key and the CF DNS token (both shared in plaintext during setup).
4. Optional: add "The Move" (1995, Browns→Baltimore) to the timeline — the biggest omission.

## Done (2026-07-01)
- Migrated Pages → Worker; deleted the stale `white-knuckle-city` Pages project.
- Wired merch signup to Resend (audience + confirmation email).
- Attached custom domain (apex + www); repointed all URLs; SEO/AEO enrichment.
