// GioAviation.aero — Worker entry point.
// Cloudflare's newer "Import a repository" flow deploys this as a Worker
// with a static-assets binding, not a classic Pages project — so the old
// functions/api/subscribe.js (Pages Functions file-based routing) is never
// invoked. This single script replaces it: it handles the one custom route
// (POST /api/subscribe) and hands everything else to the static assets.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }

    // Everything else — index.html, credenziali.html, contatti.html,
    // assets/*, resources/* — is served from the static assets binding.
    return env.ASSETS.fetch(request);
  },
};

async function handleSubscribe(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const doc = String(body.doc || "unknown").trim();

  if (!EMAIL_PATTERN.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  if (!env.SUBSCRIBERS) {
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
