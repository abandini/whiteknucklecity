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
    - `merch-cap.webp` / `merch-tee.webp` — AI product-render mockups for the merch cards.
    - `share/` — 6 banded 1200x630 share-card images (`rest`, `band-1`…`band-5`) used as the
      live OG image per tension band. Regenerate with:
      `node scripts/gen-share.js /tmp/wkc-svg && for f in /tmp/wkc-svg/*.svg; do rsvg-convert -w 1200 -h 630 "$f" -o public/assets/share/$(basename "$f" .svg).png; done`
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
- `GET /api/index`: server-computed White Knuckle Index as JSON (CORS-open, `max-age=45`).
  Mirrors the client meter's tension math. Powers the live share cards and a future badge.
- **Live share cards**: on the homepage (`/` and `/index.html`), the Worker rewrites the
  OG/Twitter meta tags (title/description/image) with the current Index via `HTMLRewriter`,
  so sharing `whiteknucklecity.com` shows a live "Index: 92 — Full clench" card. The index is
  edge-cached ~45s; if ESPN is unreachable (`known:false`) the static default tags are left
  in place rather than falsely claiming "at rest".
- **ESPN gotcha (server-side only):** ESPN's Akamai WAF **403s** workerd's default User-Agent
  AND spoofed browser UAs (a Mozilla UA without a matching browser TLS fingerprint reads as a
  bot). The server fetch therefore sends an honest client UA (`curl/8.7.1`), which returns 200.
  The client meter is unaffected — it reads ESPN from the visitor's real browser. If `/api/index`
  starts returning `known:false`, check whether ESPN changed its UA allowlist first.

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
- The SAME math also runs server-side in `src/index.js` (`computeIndex`/`tensionFor`/`band`) to power
  `/api/index` and the live share cards. Keep the two implementations in sync when tweaking the formula.

## Share / virality (live share cards)
- The Index's unfair advantage: it's a live, game-specific reaction people share DURING games.
- "Share the pain" button (`.share-row` in the Index section): native share sheet on mobile
  (`navigator.share`), X/Bluesky/Threads/copy fallback menu on desktop. Shares the homepage URL
  (with `?utm_source=share&utm_medium=<net>`), so the crawler-fetched OG card shows the live grip level.
- Card images are banded (see `assets/share/`); the exact number lives in the OG **title** text
  (rendered everywhere). To burn the exact number into the image would need runtime PNG rendering
  (satori + resvg-wasm) — deliberately deferred.

## Knuckle Alerts (cron → email)
- `wrangler.toml` `[triggers] crons = ["*/5 * * * *"]`; `scheduled()` → `runKnuckleAlerts(env)`.
- Fires once per LIVE Cleveland game that crosses `ALERT_THRESHOLD` (85). Sends a Resend
  **Broadcast** to the audience (create + send; Broadcasts handle unsubscribe/suppression).
- Dedup/idempotency via KV `alert:<league>:<gameId>`: claim a 15-min `lock` BEFORE sending
  (so an overlapping cron can't double-email), upgrade to a 24h `sent` guard on success; a
  failed send lets the lock expire so a later run retries. Only `state==='in'` games qualify.
- Needs `RESEND_API_KEY` (secret) + the `WKC` KV binding; without either it no-ops safely.
- Can't be fully e2e-tested without a live 85+ game. To dry-run the path: `wrangler dev
  --test-scheduled` then `curl localhost:PORT/__scheduled` (no key locally = clean no-op).

## Cap-vs-tee vote
- `GET/POST /api/vote` (KV counters `vote:cap` / `vote:tee`). Tallies are **entertainment-only**
  (KV read-modify-write isn't atomic — fine for a demand signal, not a certified count).
  POST validates `choice ∈ {cap,tee}`, own rate-limit bucket; front-end soft-locks re-votes via
  `localStorage`. Replaces the merch "Coming Soon" badges; a live split bar shows the result.

## Embeddable badge
- `GET /badge.svg` — dynamic on-brand SVG of the current grip level (reuses the cached index).
  `image/svg+xml`, `max-age=60`, `nosniff`, CORS-open. SVG works in `<img>` (unlike OG cards),
  so other Cleveland sites embed `<a href=site><img src=/badge.svg></a>`. The homepage shows a
  copy-paste snippet under the Index. All dynamic SVG text is escaped (`svgEsc`).

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

## Monetization
- **Amazon Associates (LIVE):** the "Required Reading" section (`#books`) links 6 Cleveland
  sports books with the site's Associates tag **`whiteknucklecity-20`**. FTC disclosure sits ABOVE
  the grid and leads with Amazon's exact required sentence; links use `rel="sponsored noopener"`.
  ⚠️ Confirm `whiteknucklecity-20` is a registered/approved tracking ID or the links won't earn.
- **Merch (planned):** print-on-demand via Printify — see below.

## Merch products (REMAINING)
- Plan: print-on-demand via Printify. Upload `wordmark-print-dark.png` (dark garments) /
  `wordmark-print-light.png` (light garments) as the design; Printify generates real product photos.
- Site shows cap + tee AI-render mockups. The "Coming Soon" badges are now **cap-vs-tee vote
  buttons** (see the Cap-vs-tee vote section) gauging demand. Once a winner is clear, set up the
  Printify product and swap the vote button for a real buy link.

## Open TODOs
1. **Set up Printify products** now that the cap-vs-tee vote is collecting demand; wire real buy
   links in place of the vote buttons once a winner is clear.
2. **Distribution** (owner task): stand up WKC accounts on X + Bluesky so shares/alerts have a home;
   pitch the `/badge.svg` embed to Cleveland blogs/newsletters/bars.
3. Verify `whiteknucklecity-20` is a registered/approved Amazon Associates tag (else links won't earn).
4. Optional: burn the exact Index number into the share image (runtime PNG via satori + resvg-wasm).
5. Optional: richer live-index logic (win probability, not just score margin).
6. Optional: rotate the Resend API key and the CF DNS token (both shared in plaintext during setup).

## Done (2026-07-01)
- Migrated Pages → Worker; deleted the stale `white-knuckle-city` Pages project.
- Wired merch signup to Resend (audience + confirmation email).
- Attached custom domain (apex + www); repointed all URLs; SEO/AEO enrichment.

## Done (2026-09-15)
- Added the "Required Reading" Amazon-affiliate section (tag `whiteknucklecity-20`, FTC-compliant).
- Built the share engine: server-side index (`/api/index`), live OG share cards via HTMLRewriter,
  6 banded share images, and the "Share the pain" button. Found/fixed the ESPN server-fetch 403.

## Done (2026-09-18)
- Shipped Knuckle Alerts (cron `*/5`, per-game dedup, claim-first send), the cap-vs-tee vote
  (`/api/vote` + KV), and the embeddable `/badge.svg`. Added the `WKC` KV namespace + cron trigger,
  reframed the signup/confirmation for consent, and split the rate-limit buckets.

## Done (2026-09-26)
- Added PostHog (public US-cloud key `phc_yMcK…`, same project as the other sites; privacy-tuned,
  localhost-skipped) so real human traffic is measurable — the `site-stats` HUMANS section reads
  PostHog and filters by `$host`. Opened the CSP for PostHog (script/connect/img). Verified live.

## Analytics
- **Cloudflare Web Analytics** (auto-injected zone beacon, `cloudflareinsights`) + **PostHog**
  (snippet at the bottom of `public/index.html`). For human numbers: `python3
  ~/.claude/skills/site-stats/scripts/site_stats.py --domain whiteknucklecity.com` (PostHog HUMANS
  can lag ~1h). Cloudflare "uniques" are mostly bots/crawlers — not the audience.
