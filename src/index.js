// White Knuckle City — Cloudflare Worker.
// Static files (index.html, assets, robots, sitemap, manifest) are served by the
// [assets] binding. The Worker adds the edge behavior around them:
//   - 301 http→https and www→apex (single canonical origin)
//   - security headers (HSTS, CSP, nosniff, referrer/permissions policy)
//   - sane cache lifetimes for /assets/*
//   - POST /api/notify: rate-limited merch signup → Resend audience + confirmation
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

export default {
  async fetch(request, env) {
    const redirect = canonicalRedirect(request);
    if (redirect) return redirect;

    const url = new URL(request.url);
    if (url.pathname === '/api/notify') {
      return decorate(await handleNotify(request, env), url.pathname);
    }
    // Anything else falls through to the static assets (index.html, robots, etc.).
    return decorate(await env.ASSETS.fetch(request), url.pathname);
  },
};
