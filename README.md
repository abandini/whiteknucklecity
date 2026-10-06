# White Knuckle City

A one-page love letter to Cleveland, Ohio sports fandom — the Guardians, Browns, and
Cavaliers — with a **live tension tracker**. Equal parts affection and "here we go again."

**Live:** https://whiteknucklecity.com

## What's on it

- **The White Knuckle Index** — a live 0–100 meter that reads the current Cleveland game
  from public ESPN scoreboards and rates how nerve-wracking the moment is. Also exposed as
  JSON (`/api/index`) and an embeddable badge (`/badge.svg`).
- **October Ball** — series status + the betting line for the live/next Cleveland playoff game.
- **Knuckle Alerts** — opt-in email when a live game crosses Index 85 (Resend).
- **Share the pain** — share buttons that render a live Index card.
- **Required Reading** — a shelf of Cleveland sports books (Amazon affiliate).
- **Cap vs. tee vote** — demand signal before the merch drop.
- A heartbreak-history timeline and an AEO-tuned FAQ.

## Stack

Cloudflare **Worker** with static assets — no framework, no build step.

- `public/` — the static site (served by the `[assets]` binding).
- `src/index.js` — the Worker: canonical redirects, security headers, `/api/*`, live
  share-card OG rewriting, and the `scheduled()` cron handlers.
- `wrangler.toml` — Worker config (assets, KV, cron triggers, custom-domain routes).

## Develop & deploy

```bash
npm install
npm run dev        # wrangler dev (local)
npm run deploy     # wrangler deploy (production)
```

`RESEND_API_KEY` is a Worker secret (`wrangler secret put RESEND_API_KEY`), never committed.
Analytics: GA4 + PostHog (public keys in the page) + Cloudflare. See `CLAUDE.md` for the full
architecture, the ESPN/odds notes, and operational details.

> Independent fan project. Not affiliated with any team, league, or broadcaster. Just the feeling.
