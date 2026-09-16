// Cloudflare Pages Function — POST /api/subscribe
// Records an email against the document it unlocked, in a KV namespace
// bound as SUBSCRIBERS (see README-DEPLOY.md for setup).

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const doc = String(body.doc || "unknown").trim();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  if (!env.SUBSCRIBERS) {
    // KV namespace not bound yet — see README-DEPLOY.md
    return json({ ok: false, error: "kv_not_configured" }, 500);
  }

  const key = `${email}::${doc}`;
  const record = { email, doc, ts: new Date().toISOString() };

  try {
    await env.SUBSCRIBERS.put(key, JSON.stringify(record));
  } catch (e) {
    return json({ ok: false, error: "storage_error" }, 500);
  }

  return json({ ok: true });
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
