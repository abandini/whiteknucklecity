// White Knuckle City — Cloudflare Worker.
// Static files (index.html, assets, robots, sitemap, manifest) are served by the
// [assets] binding. The Worker adds the edge behavior around them:
//   - 301 http→https and www→apex (single canonical origin)
//   - security headers (HSTS, CSP, nosniff, referrer/permissions policy)
//   - sane cache lifetimes for /assets/*
//   - GET  /api/index : server-computed White Knuckle Index (for share cards + badges)
//   - GET  /badge.svg : embeddable live "grip level" badge for other sites
//   - GET/POST /api/vote : cap-vs-tee demand vote (KV counters)
//   - POST /api/notify: rate-limited signup → Resend audience + confirmation
//   - live share cards: rewrites the homepage's OG/Twitter tags with the current
//     Index so sharing whiteknucklecity.com shows a live "Index: 92 — Full clench" card.
//   - scheduled(): Knuckle Alerts — emails the audience once when a live Cleveland
//     game crosses the alert threshold (per-game dedup via KV).
//
// RESEND_API_KEY is a Worker secret — it is NEVER stored in this repo.
// AUDIENCE_ID and FROM are not secrets (useless without the key), so they live here.
// WKC (KV) holds alert dedup guards + vote counters.

const AUDIENCE_ID = '9b31482a-1a9e-4a12-85d1-b911bbf24aa9';
const FROM = 'White Knuckle City <noreply@whiteknucklecity.com>';
const SITE = 'https://whiteknucklecity.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A live game at/above this grip level fires one Knuckle Alert to the audience.
const ALERT_THRESHOLD = 85;

// Per-IP request budget for the write endpoints (notify, vote): read-modify-write
// in caches.default, best-effort and per-colo. Buckets keep notify/vote separate.
const RATE_LIMIT_WINDOW = 600;   // seconds

// CSP: everything is self-hosted except Google Fonts (styles+fonts) and the
// client-side ESPN scoreboard fetches. Inline script/style are how this
// single-file site ships, hence 'unsafe-inline'. JSON-LD is non-executable
// and unaffected by script-src.
const CSP = [
  "default-src 'none'",
  // cloudflareinsights = the zone's auto-injected Web Analytics beacon;
  // us-assets.i.posthog.com serves the PostHog SDK (array.js + lazy chunks).
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://us-assets.i.posthog.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' https://us.i.posthog.com",
  // PostHog posts events to us.i.posthog.com and pulls config from us-assets.
  "connect-src 'self' https://site.api.espn.com https://cloudflareinsights.com https://us.i.posthog.com https://us-assets.i.posthog.com",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });

// ───────────────────────── White Knuckle Index (server side) ─────────────────
// Mirrors the client logic in index.html so the value on a shared card matches
// the meter. Reads the three Cleveland teams from public ESPN scoreboards.

const SPORTS = [
  { key: 'guardians', name: 'Guardians', league: 'mlb', core: 'baseball/leagues/mlb',   url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' },
  { key: 'browns',    name: 'Browns',    league: 'nfl', core: 'football/leagues/nfl',   url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
  { key: 'cavs',      name: 'Cavaliers', league: 'nba', core: 'basketball/leagues/nba', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
];

const isCle = (c) =>
  c && c.team && (c.team.abbreviation === 'CLE' || /cleveland/i.test(c.team.displayName || ''));

function findClevelandEvent(data) {
  if (!data || !Array.isArray(data.events)) return null;
  for (const ev of data.events) {
    const comp = ev.competitions && ev.competitions[0];
    if (comp && (comp.competitors || []).some(isCle)) return ev;
  }
  return null;
}

function liveTension(cle, opp, ev, comp) {
  let base = 50;
  const margin = (isNaN(cle) || isNaN(opp)) ? 5 : Math.abs(cle - opp);
  base += Math.max(-30, 35 - margin * 7);
  const period = (comp.status && comp.status.period) || (ev.status && ev.status.period) || 0;
  base += Math.min(period * 3, 18);
  return Math.max(3, Math.min(100, Math.round(base)));
}

// Evaluate the Cleveland game in one league's scoreboard. Returns a rich record
// (state, tension value, matchup) or null when there's no relevant event. The
// per-game gameId + state are what let Knuckle Alerts fire once per live game.
function evaluateGame(ev, sport) {
  if (!ev) return null;
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const st = ev.status || comp.status || {};
  const type = st.type || {};
  const state = type.state; // 'pre' | 'in' | 'post'
  const competitors = comp.competitors || [];
  const cle = competitors.find(isCle);
  const opp = competitors.find((c) => c !== cle);
  const cleScore = cle ? parseInt(cle.score, 10) : NaN;
  const oppScore = opp ? parseInt(opp.score, 10) : NaN;
  const oppAbbr = opp && opp.team ? (opp.team.abbreviation || opp.team.shortDisplayName || 'OPP') : 'OPP';
  const detail = type.shortDetail || type.detail || '';

  let value = null;
  if (state === 'pre') {
    const start = ev.date ? Date.parse(ev.date) : NaN;
    const soon = !isNaN(start) && (start - Date.now()) < 12 * 3600 * 1000;
    value = soon ? 12 : null; // only a game within ~12h counts as tension
  } else if (state === 'post') {
    value = cleScore > oppScore ? 5 : 30;
  } else if (state === 'in') {
    value = liveTension(cleScore, oppScore, ev, comp);
  }

  return {
    league: sport.league, team: sport.name,
    gameId: String(ev.id || comp.id || ''),
    state: state || 'unknown', value,
    oppAbbr, cleScore, oppScore, detail,
  };
}

// Map an overall value (number|null) to the shareable band metadata.
function band(value) {
  if (value == null)  return { key: 'rest',   word: 'At rest',         label: 'No Cleveland game right now. Rare footage.', color: '#9aa1ab' };
  if (value < 20)     return { key: 'band-1', word: 'Loose grip',      label: 'Cleveland can almost relax.',              color: '#3ba776' };
  if (value < 45)     return { key: 'band-2', word: 'Palms warming',   label: 'Something is brewing.',                    color: '#d8b33a' };
  if (value < 70)     return { key: 'band-3', word: 'Knuckles paling', label: 'Do not leave the room.',                   color: '#e07a2f' };
  if (value < 88)     return { key: 'band-4', word: 'Full clench',     label: 'Nobody speak.',                            color: '#d7263d' };
  return                     { key: 'band-5', word: 'Maximum grip',    label: 'Hold onto something solid.',               color: '#7d0f1e' };
}

// Social-card copy for a given index snapshot.
function shareMeta(snap) {
  const b = band(snap.value);
  const image = `${SITE}/assets/share/${b.key}.png`;
  const title = snap.value == null
    ? "White Knuckle City — Cleveland's at rest (rare footage)."
    : `White Knuckle Index: ${snap.value}/100 — ${b.word}.`;
  const description = snap.value == null
    ? 'A live tension meter for Cleveland sports — Guardians, Browns, Cavaliers. Check it during the next game.'
    : `${b.label} Live tension for the Guardians, Browns & Cavs, right now.`;
  const alt = snap.value == null
    ? 'The White Knuckle Index — currently at rest.'
    : `The White Knuckle Index at ${snap.value} of 100 — ${b.word}.`;
  return { title, description, image, alt, band: b.key, word: b.word, label: b.label };
}

// Compute the index across all three teams. `known:false` means we could not
// read the scoreboards (network/error) — callers then leave defaults in place
// rather than falsely claiming "at rest".
async function computeIndex() {
  const results = await Promise.allSettled(
    SPORTS.map(async (s) => {
      // ESPN's WAF (Akamai) is fussy about the caller: it 403s workerd's default
      // UA AND a spoofed browser UA (a Mozilla UA without a matching browser TLS
      // fingerprint reads as a bot-in-disguise), but it allows honest HTTP-client
      // UAs. curl's is the simplest that returns 200. The client meter is
      // unaffected — it reads ESPN directly from the visitor's real browser.
      const res = await fetch(s.url, {
        headers: { 'user-agent': 'curl/8.7.1' },
        cf: { cacheTtl: 30, cacheEverything: true },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error('bad status ' + res.status);
      return evaluateGame(findClevelandEvent(await res.json()), s);
    })
  );
  const anyOk = results.some((r) => r.status === 'fulfilled');
  if (!anyOk) return { known: false, value: null, updated: Date.now(), games: [] };
  const games = results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
  const active = games.map((g) => g.value).filter((v) => typeof v === 'number');
  const value = active.length ? Math.max(...active) : null;
  return { known: true, value, updated: Date.now(), games };
}

// Edge-cached wrapper: one ESPN round-trip is shared by all requests for ~45s.
async function getIndex() {
  const cache = caches.default;
  const key = new Request('https://index.wkc.internal/index.json');
  const hit = await cache.match(key);
  if (hit) { try { return await hit.json(); } catch (_) { /* fall through */ } }
  let snap;
  try {
    snap = await computeIndex();
  } catch (_) {
    snap = { known: false, value: null, updated: Date.now() };
  }
  // Only cache a real reading; don't pin an error for 45s.
  if (snap.known) {
    await cache.put(key, new Response(JSON.stringify(snap), {
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=45' },
    }));
  }
  return snap;
}

// Rewrites the homepage social tags with the live snapshot. One class instance
// per meta name we want to override.
class SetContent {
  constructor(value) { this.value = value; }
  element(el) { el.setAttribute('content', this.value); }
}

function liveOgRewriter(meta) {
  return new HTMLRewriter()
    .on('meta[property="og:title"]',        new SetContent(meta.title))
    .on('meta[name="twitter:title"]',       new SetContent(meta.title))
    .on('meta[property="og:description"]',  new SetContent(meta.description))
    .on('meta[name="twitter:description"]', new SetContent(meta.description))
    .on('meta[property="og:image"]',        new SetContent(meta.image))
    .on('meta[name="twitter:image"]',       new SetContent(meta.image))
    .on('meta[property="og:image:alt"]',    new SetContent(meta.alt))
    .on('meta[name="twitter:image:alt"]',   new SetContent(meta.alt));
}

/** 301 to the canonical origin when the request is http:// or www. */
function canonicalRedirect(request) {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const needsHttps = proto === 'http';
  const needsApex = url.hostname === 'www.whiteknucklecity.com';
  if (!needsHttps && !needsApex) return null;
  url.protocol = 'https:';
  if (needsApex) url.hostname = 'whiteknucklecity.com';
  return Response.redirect(url.toString(), 301);
}

/** Clone a response with security headers (and cache policy for assets). */
function decorate(response, pathname) {
  const r = new Response(response.body, response);
  r.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  r.headers.set('x-content-type-options', 'nosniff');
  r.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  r.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  const type = r.headers.get('content-type') || '';
  if (type.includes('text/html')) r.headers.set('content-security-policy', CSP);
  // Images/wordmarks change rarely; a day of caching is safe because deploys
  // that must show instantly (HTML) stay on revalidate-always.
  if (pathname.startsWith('/assets/')) {
    r.headers.set('cache-control', 'public, max-age=86400');
  }
  return r;
}

/** Sliding-ish per-IP counter in the colo cache. Best-effort abuse damping:
 *  per-colo (a distributed attacker gets a budget per colo) and read-modify-write
 *  (not atomic), which is fine for protecting an email endpoint. */
async function rateLimited(request, bucket, max) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = new Request(`https://rate-limit.wkc.internal/${bucket}/` + encodeURIComponent(ip));
  const cache = caches.default;
  let count = 0;
  const hit = await cache.match(key);
  if (hit) count = parseInt(await hit.text(), 10) || 0;
  if (count >= max) return true;
  await cache.put(
    key,
    new Response(String(count + 1), {
      headers: { 'cache-control': 'max-age=' + RATE_LIMIT_WINDOW },
    }),
  );
  return false;
}

async function handleNotify(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.RESEND_API_KEY) return json({ ok: false, error: 'not_configured' }, 500);

  if (await rateLimited(request, 'notify', 5)) {
    return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(RATE_LIMIT_WINDOW) });
  }

  let email = '';
  try {
    const body = await request.json();
    email = String(body.email || '').trim().toLowerCase();
  } catch (_) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: 'invalid_email' }, 422);
  }

  const auth = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  const contactUrl = `https://api.resend.com/audiences/${AUDIENCE_ID}/contacts`;

  // Duplicate check first: Resend's create is idempotent (201 either way), so
  // an existing contact is only detectable via GET. Skipping the confirmation
  // for known contacts is what closes the email-bombing hole.
  try {
    const existing = await fetch(`${contactUrl}/${encodeURIComponent(email)}`, { headers: auth });
    if (existing.ok) return json({ ok: true, duplicate: true });
  } catch (_) { /* on lookup failure, fall through and treat as new */ }

  // 1) Add to the audience — the durable list the owner can broadcast to later.
  let stored = false;
  try {
    const r = await fetch(contactUrl, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    stored = r.ok;
  } catch (_) { /* network error -> stored stays false */ }

  if (!stored) return json({ ok: false, error: 'store_failed' }, 502);

  // 2) Best-effort confirmation email. If this bounces, the signup still counts.
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        from: FROM,
        to: email,
        subject: "You're on the list — White Knuckle City",
        text:
          "You're in.\n\nTwo things land in this inbox, and nothing else:\n" +
          "  • Knuckle Alerts — a heads-up when a Cleveland game goes fully sideways (the Index crosses 85).\n" +
          "  • The drop — first crack when the merch is ready.\n\n" +
          "Until then: grip tighter.\n" + SITE + "\n\n" +
          "Made in the 216 · Not affiliated with any team, league, or broadcaster. Just the feeling.\n" +
          "Every email has a one-click unsubscribe. No hard feelings.",
        html:
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0b0d10;color:#f4f1ea;border-radius:12px">' +
          '<h1 style="font-family:Arial Black,Arial,sans-serif;font-size:26px;margin:0;letter-spacing:0.5px">YOU\'RE ON THE LIST</h1>' +
          '<p style="color:#9aa1ab;font-size:15px;line-height:1.6;margin:14px 0">Two things land here, nothing else:</p>' +
          '<ul style="color:#9aa1ab;font-size:15px;line-height:1.6;margin:0 0 14px;padding-left:20px">' +
          '<li><b style="color:#f4f1ea">Knuckle Alerts</b> — a heads-up when a Cleveland game goes fully sideways (the Index crosses 85).</li>' +
          '<li><b style="color:#f4f1ea">The drop</b> — first crack when the merch is ready.</li></ul>' +
          '<a href="' + SITE + '" style="display:inline-block;background:#d7263d;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:700;font-size:14px;margin-top:6px">Back to White Knuckle City</a>' +
          '<p style="color:#9aa1ab;font-size:11px;opacity:0.7;margin-top:22px">Made in the 216 · Not affiliated with any team, league, or broadcaster. Just the feeling.<br>Every email has a one-click unsubscribe. No hard feelings.</p>' +
          '</div>',
      }),
    });
  } catch (_) { /* email is best-effort */ }

  return json({ ok: true });
}

const ESPN_UA = { 'user-agent': 'curl/8.7.1' };

// Find the most relevant Cleveland game across the three leagues: prefer a live
// game, then an upcoming one, then the most recent final. Returns the sport +
// ESPN event, or null. (Odds/series aren't in the client's CORS feed, so this
// runs server-side.)
async function findClevelandGame() {
  let best = null; // {sport, ev, rank, start}
  const rank = (s) => (s === 'in' ? 3 : s === 'pre' ? 2 : 1);
  await Promise.all(SPORTS.map(async (s) => {
    try {
      const res = await fetch(s.url, { headers: ESPN_UA, cf: { cacheTtl: 60 }, signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      const ev = findClevelandEvent(await res.json());
      if (!ev) return;
      const state = (((ev.status || {}).type) || {}).state || 'post';
      const start = ev.date ? Date.parse(ev.date) : 0;
      const cand = { sport: s, ev, rank: rank(state), start };
      if (!best || cand.rank > best.rank || (cand.rank === best.rank && cand.start > best.start)) best = cand;
    } catch (_) { /* skip this league */ }
  }));
  return best;
}

// GET /api/odds — series status + betting line for the next/current Cleveland
// playoff (or regular) game. Odds come from ESPN's core API (DraftKings line).
// Cached ~5 min. Returns { ok, game: {...} | null }. Entertainment only.
async function handleOdds() {
  const cache = caches.default;
  const cacheKey = new Request('https://odds.wkc.internal/odds.json');
  const hit = await cache.match(cacheKey);
  if (hit) { try { return new Response(hit.body, hit); } catch (_) {} }

  let payload = { ok: true, game: null };
  const found = await findClevelandGame();
  if (found) {
    const { sport, ev } = found;
    const comp = ev.competitions[0];
    const type = ((ev.status || {}).type) || {};
    const state = type.state || 'post';
    const competitors = comp.competitors || [];
    const cle = competitors.find(isCle);
    const opp = competitors.find((c) => c !== cle);
    const series = comp.series || ev.series || null;

    const game = {
      league: sport.league, team: sport.name,
      state, detail: type.shortDetail || type.detail || '',
      home: cle && cle.homeAway === 'home',
      oppAbbr: opp && opp.team ? (opp.team.abbreviation || opp.team.shortDisplayName || 'OPP') : 'OPP',
      oppName: opp && opp.team ? (opp.team.shortDisplayName || opp.team.displayName || 'Opponent') : 'Opponent',
      cleScore: cle ? cle.score : null, oppScore: opp ? opp.score : null,
      series: series ? { title: series.title || 'Series', summary: series.summary || '' } : null,
      odds: null,
    };

    // Odds only make sense before/while the game is live.
    if (state === 'pre' || state === 'in') {
      try {
        const id = ev.id;
        const oRes = await fetch(
          `https://sports.core.api.espn.com/v2/sports/${sport.core}/events/${id}/competitions/${id}/odds`,
          { headers: ESPN_UA, cf: { cacheTtl: 300 }, signal: AbortSignal.timeout(4000) });
        if (oRes.ok) {
          const od = await oRes.json();
          const o = (od.items || [])[0];
          if (o) {
            game.odds = {
              provider: (o.provider || {}).name || 'DraftKings',
              details: o.details || '',           // e.g. "CLE -136"
              overUnder: o.overUnder ?? null,
              spread: o.spread ?? null,
              cleML: (cle && cle.homeAway === 'home' ? o.homeTeamOdds : o.awayTeamOdds)?.moneyLine ?? null,
              oppML: (cle && cle.homeAway === 'home' ? o.awayTeamOdds : o.homeTeamOdds)?.moneyLine ?? null,
            };
          }
        }
      } catch (_) { /* odds are best-effort */ }
    }
    payload = { ok: true, game };
  }

  const res = json(payload, 200, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
  try { await cache.put(cacheKey, res.clone()); } catch (_) {}
  return res;
}

// Dynamic sitemap: same single URL, but lastmod rolls to today so crawlers see a
// fresh signal on the daily cadence without a build step.
function dynamicSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://whiteknucklecity.com/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

// GET /api/index — the live index as JSON. Public, cacheable, CORS-open so it
// can power an embeddable "current grip level" badge on other Cleveland sites.
async function handleIndexApi() {
  const snap = await getIndex();
  const meta = shareMeta(snap);
  return json(
    {
      ok: true,
      known: snap.known !== false,
      value: snap.value,
      band: meta.band,
      word: meta.word,
      label: meta.label,
      updated: snap.updated,
    },
    200,
    {
      'cache-control': 'public, max-age=45',
      'access-control-allow-origin': '*',
    },
  );
}

// GET/POST /api/vote — the cap-vs-tee demand vote. Counters live in KV.
// Tallies are entertainment-only (KV read-modify-write is not atomic); good
// enough to gauge which product to make first, not a certified election.
async function handleVote(request, env) {
  if (!env.WKC) return json({ ok: false, error: 'not_configured' }, 500);

  const counts = async () => {
    const [cap, tee] = await Promise.all([env.WKC.get('vote:cap'), env.WKC.get('vote:tee')]);
    return { cap: parseInt(cap || '0', 10) || 0, tee: parseInt(tee || '0', 10) || 0 };
  };

  if (request.method === 'GET') {
    return json({ ok: true, ...(await counts()) }, 200, { 'cache-control': 'public, max-age=15' });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (await rateLimited(request, 'vote', 8)) {
    return json({ ok: false, error: 'rate_limited', ...(await counts()) }, 429);
  }

  let choice = '';
  try {
    const body = await request.json();
    choice = String(body.choice || '');
  } catch (_) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (choice !== 'cap' && choice !== 'tee') return json({ ok: false, error: 'invalid_choice' }, 422);

  const key = 'vote:' + choice;
  const cur = parseInt((await env.WKC.get(key)) || '0', 10) || 0;
  await env.WKC.put(key, String(cur + 1));
  return json({ ok: true, ...(await counts()) });
}

const svgEsc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GET /badge.svg — a small live badge other sites can embed as an <img>. SVG in
// <img> is fine (unlike OG cards). Short cache; nosniff added by decorate().
function badgeSvg(snap) {
  const b = band(snap.value);
  const value = snap.value == null ? 'AT REST' : `${snap.value}/100`;
  const pct = snap.value == null ? 6 : Math.max(2, Math.min(98, snap.value));
  const nx = 16 + (308 * pct / 100);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="96" viewBox="0 0 340 96" role="img" aria-label="White Knuckle Index: ${svgEsc(value)} — ${svgEsc(b.word)}">
  <defs><linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3ba776"/><stop offset="0.45" stop-color="#d8b33a"/><stop offset="0.78" stop-color="#d7263d"/><stop offset="1" stop-color="#7d0f1e"/></linearGradient></defs>
  <rect x="0.5" y="0.5" width="339" height="95" rx="12" fill="#0b0d10" stroke="rgba(255,255,255,0.10)"/>
  <rect x="0" y="0" width="340" height="4" rx="2" fill="${b.color}"/>
  <text x="16" y="28" font-family="Arial,Helvetica,sans-serif" font-size="11" font-weight="bold" letter-spacing="2" fill="#9aa1ab">THE WHITE KNUCKLE INDEX</text>
  <text x="16" y="60" font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="bold" fill="#f4f1ea">${svgEsc(value)}</text>
  <text x="324" y="60" text-anchor="end" font-family="Arial,Helvetica,sans-serif" font-size="15" font-style="italic" fill="${b.color}">${svgEsc(b.word)}</text>
  <rect x="16" y="74" width="308" height="10" rx="5" fill="url(#bar)"/>
  <rect x="${(nx - 2).toFixed(1)}" y="71" width="4" height="16" rx="2" fill="#fff"/>
</svg>`;
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' } });
}

// Send one Knuckle Alert broadcast to the whole audience via Resend Broadcasts
// (handles unsubscribe/suppression). Two steps: create then send.
async function sendKnuckleAlert(env, game) {
  const auth = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  const matchup = `${game.team} vs ${game.oppAbbr}${game.detail ? ' · ' + game.detail : ''}`;
  const subject = `🫲 Knuckle Alert: ${game.value}/100 — ${game.team} vs ${game.oppAbbr}`;
  const html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0b0d10;color:#f4f1ea;border-radius:12px">' +
    '<p style="color:#d7263d;font-size:12px;letter-spacing:3px;text-transform:uppercase;margin:0 0 6px">Knuckle Alert</p>' +
    `<h1 style="font-family:Arial Black,Arial,sans-serif;font-size:30px;margin:0">${svgEsc(String(game.value))} / 100</h1>` +
    `<p style="color:#f4f1ea;font-size:16px;margin:10px 0 2px">${svgEsc(matchup)}</p>` +
    '<p style="color:#9aa1ab;font-size:15px;line-height:1.6;margin:6px 0 16px">Cleveland just crossed into the red. Do not leave the room.</p>' +
    `<a href="${SITE}" style="display:inline-block;background:#d7263d;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:700;font-size:14px">Watch the Index</a>` +
    '<p style="color:#9aa1ab;font-size:11px;opacity:0.7;margin-top:22px">Made in the 216 · Not affiliated with any team, league, or broadcaster. Just the feeling.</p>' +
    '</div>';
  const text = `Knuckle Alert — ${game.value}/100\n${matchup}\nCleveland just crossed into the red. Do not leave the room.\n\n${SITE}`;

  const create = await fetch('https://api.resend.com/broadcasts', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ audience_id: AUDIENCE_ID, from: FROM, subject, html, text }),
  });
  if (!create.ok) return false;
  const created = await create.json().catch(() => ({}));
  if (!created.id) return false;
  const send = await fetch(`https://api.resend.com/broadcasts/${created.id}/send`, { method: 'POST', headers: auth });
  return send.ok;
}

// Cron entry: check the index; alert once per live game that crosses the
// threshold. Claim a KV lock BEFORE sending so an overlapping run can't double
// -email; on success upgrade the lock to a 24h "sent" guard, on failure let the
// short lock expire so a later run retries.
async function runKnuckleAlerts(env) {
  if (!env.RESEND_API_KEY || !env.WKC) return;
  let snap;
  try { snap = await computeIndex(); } catch (_) { return; }
  if (!snap.known || !Array.isArray(snap.games)) return;

  for (const g of snap.games) {
    if (g.state !== 'in' || typeof g.value !== 'number' || g.value < ALERT_THRESHOLD || !g.gameId) continue;
    const key = `alert:${g.league}:${g.gameId}`;
    const seen = await env.WKC.get(key);
    if (seen === 'sent' || seen === 'lock') continue;       // already alerted / in flight
    await env.WKC.put(key, 'lock', { expirationTtl: 900 }); // 15-min claim
    const ok = await sendKnuckleAlert(env, g);
    if (ok) {
      await env.WKC.put(key, 'sent', { expirationTtl: 86400 });
      console.log('knuckle alert sent', key, g.value);
    } else {
      console.log('knuckle alert send failed (will retry after lock expires)', key);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    // The */5 job drives Knuckle Alerts. The daily 04:00 UTC job also refreshes
    // the odds + index caches so the board is clean each morning after late games.
    ctx.waitUntil((async () => {
      await runKnuckleAlerts(env);
      if (event.cron === '0 4 * * *') {
        const cache = caches.default;
        try { await cache.delete(new Request('https://index.wkc.internal/index.json')); } catch (_) {}
        try { await cache.delete(new Request('https://odds.wkc.internal/odds.json')); } catch (_) {}
        try { await getIndex(); } catch (_) {}
        try { await handleOdds(); } catch (_) {}
      }
    })());
  },

  async fetch(request, env) {
    const redirect = canonicalRedirect(request);
    if (redirect) return redirect;

    const url = new URL(request.url);

    if (url.pathname === '/api/notify') {
      return decorate(await handleNotify(request, env), url.pathname);
    }
    if (url.pathname === '/api/index') {
      return decorate(await handleIndexApi(), url.pathname);
    }
    if (url.pathname === '/api/vote') {
      return decorate(await handleVote(request, env), url.pathname);
    }
    if (url.pathname === '/badge.svg') {
      return decorate(badgeSvg(await getIndex()), url.pathname);
    }
    if (url.pathname === '/api/odds') {
      return decorate(await handleOdds(), url.pathname);
    }
    if (url.pathname === '/sitemap.xml') {
      return decorate(dynamicSitemap(), url.pathname);
    }

    // Serve the static asset. For the homepage, rewrite the social tags with
    // the live index so a shared link shows the current grip level.
    const assetRes = await env.ASSETS.fetch(request);
    const isHome = url.pathname === '/' || url.pathname === '/index.html';
    const isHtml = (assetRes.headers.get('content-type') || '').includes('text/html');
    if (isHome && isHtml && request.method === 'GET') {
      const snap = await getIndex();
      if (snap.known) {
        const transformed = liveOgRewriter(shareMeta(snap)).transform(assetRes);
        return decorate(transformed, url.pathname);
      }
    }
    return decorate(assetRes, url.pathname);
  },
};
