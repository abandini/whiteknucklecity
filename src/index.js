// White Knuckle City — Cloudflare Worker.
// Static files (index.html, assets, robots, sitemap, manifest) are served by the
// [assets] binding. This Worker only handles the merch-notify signup endpoint.
//
// RESEND_API_KEY is a Worker secret — it is NEVER stored in this repo.
// AUDIENCE_ID and FROM are not secrets (useless without the key), so they live here.
// When whiteknucklecity.com is attached, swap SITE to https://whiteknucklecity.com/.

const AUDIENCE_ID = '9b31482a-1a9e-4a12-85d1-b911bbf24aa9';
const FROM = 'White Knuckle City <noreply@whiteknucklecity.com>';
const SITE = 'https://white-knuckle-city.bill-burkey.workers.dev';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

async function handleNotify(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.RESEND_API_KEY) return json({ ok: false, error: 'not_configured' }, 500);

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

  // 1) Add to the audience — the durable list the owner can broadcast to later.
  //    A duplicate (already subscribed) is a success, not an error.
  let stored = false;
  try {
    const r = await fetch(`https://api.resend.com/audiences/${AUDIENCE_ID}/contacts`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    stored = r.ok || r.status === 409 || r.status === 422;
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
    const url = new URL(request.url);
    if (url.pathname === '/api/notify') return handleNotify(request, env);
    // Anything else falls through to the static assets (index.html, robots, etc.).
    return env.ASSETS.fetch(request);
  },
};
