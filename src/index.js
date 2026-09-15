// White Knuckle City — Cloudflare Worker.
// Static files (index.html, assets, robots, sitemap, manifest) are served by the
// [assets] binding. The Worker adds the edge behavior around them:
//   - 301 http→https and www→apex (single canonical origin)
//   - security headers (HSTS, CSP, nosniff, referrer/permissions policy)
//   - sane cache lifetimes for /assets/*
//   - GET  /api/index : server-computed White Knuckle Index (for share cards + badges)
//   - POST /api/notify: rate-limited merch signup → Resend audience + confirmation
//   - live share cards: rewrites the homepage's OG/Twitter tags with the current
//     Index so sharing whiteknucklecity.com shows a live "Index: 92 — Full clench" card.
//
// RESEND_API_KEY is a Worker secret — it is NEVER stored in this repo.
// AUDIENCE_ID and FROM are not secrets (useless without the key), so they live here.

const AUDIENCE_ID = '9b31482a-1a9e-4a12-85d1-b911bbf24aa9';
const FROM = 'White Knuckle City <noreply@whiteknucklecity.com>';
const SITE = 'https://whiteknucklecity.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// /api/notify budget: writes to a third-party API and sends email, so keep it tight.
const RATE_LIMIT_MAX = 5;        // requests…
const RATE_LIMIT_WINDOW = 600;   // …per this many seconds, per IP

// CSP: everything is self-hosted except Google Fonts (styles+fonts) and the
// client-side ESPN scoreboard fetches. Inline script/style are how this
// single-file site ships, hence 'unsafe-inline'. JSON-LD is non-executable
// and unaffected by script-src.
const CSP = [
  "default-src 'none'",
  // cloudflareinsights = the zone's auto-injected Web Analytics beacon
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "connect-src 'self' https://site.api.espn.com https://cloudflareinsights.com",
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
  { key: 'guardians', name: 'Guardians', url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' },
  { key: 'browns',    name: 'Browns',    url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
  { key: 'cavs',      name: 'Cavaliers', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
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

// Returns a tension number for a live/pre game, or null (no game / far off).
function tensionFor(ev) {
  if (!ev) return null;
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const st = ev.status || comp.status || {};
  const state = (st.type || {}).state; // 'pre' | 'in' | 'post'
  const competitors = comp.competitors || [];
  const cle = competitors.find(isCle);
  const opp = competitors.find((c) => c !== cle);
  const cleScore = cle ? parseInt(cle.score, 10) : NaN;
  const oppScore = opp ? parseInt(opp.score, 10) : NaN;

  if (state === 'pre') {
    const start = ev.date ? Date.parse(ev.date) : NaN;
    const soon = !isNaN(start) && (start - Date.now()) < 12 * 3600 * 1000;
    return soon ? 12 : null; // only a game within ~12h counts as tension
  }
  if (state === 'post') return cleScore > oppScore ? 5 : 30;
  return liveTension(cleScore, oppScore, ev, comp);
}

// Map an overall value (number|null) to the shareable band metadata.
function band(value) {
  if (value == null)  return { key: 'rest',   word: 'At rest',         label: 'No Cleveland game right now. Rare footage.' };
  if (value < 20)     return { key: 'band-1', word: 'Loose grip',      label: 'Cleveland can almost relax.' };
  if (value < 45)     return { key: 'band-2', word: 'Palms warming',   label: 'Something is brewing.' };
  if (value < 70)     return { key: 'band-3', word: 'Knuckles paling', label: 'Do not leave the room.' };
  if (value < 88)     return { key: 'band-4', word: 'Full clench',     label: 'Nobody speak.' };
  return                     { key: 'band-5', word: 'Maximum grip',    label: 'Hold onto something solid.' };
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
      return tensionFor(findClevelandEvent(await res.json()));
    })
  );
  const anyOk = results.some((r) => r.status === 'fulfilled');
  if (!anyOk) return { known: false, value: null, updated: Date.now() };
  const active = results
    .filter((r) => r.status === 'fulfilled' && typeof r.value === 'number')
    .map((r) => r.value);
  const value = active.length ? Math.max(...active) : null;
  return { known: true, value, updated: Date.now() };
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
async function rateLimited(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = new Request('https://rate-limit.wkc.internal/notify/' + encodeURIComponent(ip));
  const cache = caches.default;
  let count = 0;
  const hit = await cache.match(key);
  if (hit) count = parseInt(await hit.text(), 10) || 0;
  if (count >= RATE_LIMIT_MAX) return true;
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

  if (await rateLimited(request)) {
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
          "You're in.\n\nWhen the White Knuckle City drop lands, you get first crack at it — nothing else.\n\n" +
          "Until then: grip tighter.\n" + SITE + "\n\n" +
          "Made in the 216 · Not affiliated with any team, league, or broadcaster. Just the feeling.",
        html:
          '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0b0d10;color:#f4f1ea;border-radius:12px">' +
          '<h1 style="font-family:Arial Black,Arial,sans-serif;font-size:26px;margin:0;letter-spacing:0.5px">YOU\'RE ON THE LIST</h1>' +
          '<p style="color:#9aa1ab;font-size:15px;line-height:1.6;margin:14px 0">When the drop lands, you get first crack at it — nothing else. Until then, grip tighter.</p>' +
          '<a href="' + SITE + '" style="display:inline-block;background:#d7263d;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-weight:700;font-size:14px;margin-top:6px">Back to White Knuckle City</a>' +
          '<p style="color:#9aa1ab;font-size:11px;opacity:0.7;margin-top:22px">Made in the 216 · Not affiliated with any team, league, or broadcaster. Just the feeling.</p>' +
          '</div>',
      }),
    });
  } catch (_) { /* email is best-effort */ }

  return json({ ok: true });
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

export default {
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
