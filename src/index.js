// GioAviation.aero — Worker entry point.
//
// Handles:
//  - Access control: only a short public allow-list is served without a
//    session; everything else (resources, contatti, credenziali) requires a
//    logged-in pilot session, and /admin.html + /api/admin/* require an
//    admin session.
//  - Pilot self-service: POST /api/request-access (queues a pending row),
//    POST /api/login, GET /api/logout.
//  - Admin workflow: POST /api/admin/login, GET /api/admin/requests,
//    POST /api/admin/approve, POST /api/admin/reject, GET /api/admin/logout.
//    Approving generates a password, stores its hash, and emails the
//    plaintext password to the pilot via Resend.
//
// Required bindings (Worker → Settings → Bindings / Variables & Secrets):
//   DB                 D1 database bound as "DB" (schema.sql)
//   SESSION_SECRET     secret, long random string — signs session cookies
//   ADMIN_PASSWORD     secret — the single admin password for /admin.html
//   RESEND_API_KEY     secret — from resend.com, used to send email
//   RESEND_FROM        var    — e.g. "GioAviation.com <access@gioaviation.com>"
//     (the domain in RESEND_FROM must be verified in your Resend account —
//     as of now only gioaviation.com is verified there, not gioaviation.aero)
//   ADMIN_NOTIFY_EMAIL var    — where to send "new access request" notices.
//     Optional: if unset, new requests are simply not notified by email —
//     you'd only see them by opening admin.html.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE = "gio_session";
const PILOT_SESSION_DAYS = 30;
const ADMIN_SESSION_HOURS = 12;

// Paths servable with no session at all. Cloudflare's static-assets layer
// normalizes "/foo.html" requests to "/foo" (html_handling default), and
// with run_worker_first that normalized request comes back through this
// same fetch handler — so both forms must be listed, or a protected route
// serving the extensionless redirect target loops forever.
const PUBLIC_PATHS = new Set([
  "/",
  "/index.html",
  "/index",
  "/richiedi-accesso.html",
  "/richiedi-accesso",
  "/login.html",
  "/login",
  "/admin-login.html",
  "/admin-login",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      return handleApi(request, env, path);
    }

    if (PUBLIC_PATHS.has(path) || path.startsWith("/assets/")) {
      return env.ASSETS.fetch(request);
    }

    if (path === "/admin.html" || path === "/admin") {
      const session = await getSession(request, env);
      if (!session || session.role !== "admin") {
        return Response.redirect(new URL("/admin-login.html", url), 302);
      }
      return env.ASSETS.fetch(request);
    }

    // Everything else (risorse.html, contatti.html, credenziali.html,
    // resources/*) requires a logged-in pilot (or admin).
    const session = await getSession(request, env);
    if (!session) {
      const to = new URL("/login.html", url);
      to.searchParams.set("next", path);
      return Response.redirect(to, 302);
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------- routing --

async function handleApi(request, env, path) {
  const method = request.method;

  if (path === "/api/request-access" && method === "POST") return apiRequestAccess(request, env);
  if (path === "/api/login" && method === "POST") return apiLogin(request, env);
  if (path === "/api/logout") return apiLogout();

  if (path === "/api/admin/login" && method === "POST") return apiAdminLogin(request, env);
  if (path === "/api/admin/logout") return apiLogout();

  if (path === "/api/admin/requests" && method === "GET") return apiAdminList(request, env);
  if (path === "/api/admin/approve" && method === "POST") return apiAdminApprove(request, env);
  if (path === "/api/admin/reject" && method === "POST") return apiAdminReject(request, env);

  return json({ ok: false, error: "not_found" }, 404);
}

// ------------------------------------------------------------- pilot APIs --

async function apiRequestAccess(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);

  const email = String(body.email || "").trim().toLowerCase();
  const fullName = String(body.full_name || "").trim();
  const company = String(body.company || "").trim();
  const note = String(body.note || "").trim();

  if (!EMAIL_PATTERN.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
  if (!fullName) return json({ ok: false, error: "missing_name" }, 400);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const existing = await env.DB.prepare("SELECT status FROM pilots WHERE email = ?").bind(email).first();

  if (existing) {
    if (existing.status === "approved") return json({ ok: false, error: "already_approved" }, 409);
    if (existing.status === "pending") return json({ ok: false, error: "already_pending" }, 409);
    // previously rejected — allow a fresh request
    await env.DB.prepare(
      "UPDATE pilots SET full_name = ?, company = ?, note = ?, status = 'pending', created_at = ? WHERE email = ?"
    ).bind(fullName, company, note, new Date().toISOString(), email).run();
    await notifyAdminOfNewRequest(env, { email, fullName, company, note });
    return json({ ok: true });
  }

  await env.DB.prepare(
    "INSERT INTO pilots (email, full_name, company, note, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
  ).bind(email, fullName, company, note, new Date().toISOString()).run();

  await notifyAdminOfNewRequest(env, { email, fullName, company, note });

  return json({ ok: true });
}

async function apiLogin(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return json({ ok: false, error: "missing_fields" }, 400);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const pilot = await env.DB.prepare(
    "SELECT id, email, full_name, status, password_hash, password_salt FROM pilots WHERE email = ?"
  ).bind(email).first();

  if (!pilot || pilot.status !== "approved" || !pilot.password_hash) {
    return json({ ok: false, error: "invalid_credentials" }, 401);
  }

  const { hash } = await hashPassword(password, pilot.password_salt);
  if (!timingSafeEqualStr(hash, pilot.password_hash)) {
    return json({ ok: false, error: "invalid_credentials" }, 401);
  }

  const cookie = await createSessionCookie(env, {
    role: "pilot",
    id: pilot.id,
    email: pilot.email,
    exp: Date.now() + PILOT_SESSION_DAYS * 86400000,
  });

  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

function apiLogout() {
  const expired = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": expired } });
}

// ------------------------------------------------------------- admin APIs --

async function apiAdminLogin(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "admin_not_configured" }, 500);

  const password = String(body.password || "");
  if (!timingSafeEqualStr(password, env.ADMIN_PASSWORD)) {
    return json({ ok: false, error: "invalid_credentials" }, 401);
  }

  const cookie = await createSessionCookie(env, {
    role: "admin",
    exp: Date.now() + ADMIN_SESSION_HOURS * 3600000,
  });

  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

async function requireAdmin(request, env) {
  const session = await getSession(request, env);
  return session && session.role === "admin" ? session : null;
}

async function apiAdminList(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const { results } = await env.DB.prepare(
    "SELECT id, email, full_name, company, note, status, created_at, approved_at FROM pilots ORDER BY created_at DESC"
  ).all();

  return json({ ok: true, pilots: results });
}

async function apiAdminApprove(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  const id = body && Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const pilot = await env.DB.prepare("SELECT id, email, full_name FROM pilots WHERE id = ?").bind(id).first();
  if (!pilot) return json({ ok: false, error: "not_found" }, 404);

  const password = generatePassword();
  const { hash, salt } = await hashPassword(password);

  await env.DB.prepare(
    "UPDATE pilots SET status = 'approved', password_hash = ?, password_salt = ?, approved_at = ? WHERE id = ?"
  ).bind(hash, salt, new Date().toISOString(), id).run();

  let emailSent = false;
  let emailError = null;
  try {
    await sendCredentialsEmail(env, { email: pilot.email, fullName: pilot.full_name, password });
    emailSent = true;
  } catch (e) {
    emailError = String(e && e.message ? e.message : e);
  }

  return json({ ok: true, email_sent: emailSent, email_error: emailError });
}

async function apiAdminReject(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  const id = body && Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  await env.DB.prepare("UPDATE pilots SET status = 'rejected' WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------ email --

async function sendCredentialsEmail(env, { email, fullName, password }) {
  const loginUrl = "https://gioaviation.aero/login.html";

  const html = `
    <p>Ciao ${escapeHtml(fullName)},</p>
    <p>Il tuo accesso a GioAviation.aero &egrave; stato approvato. Ecco le tue credenziali:</p>
    <p><strong>Email:</strong> ${escapeHtml(email)}<br>
    <strong>Password:</strong> ${escapeHtml(password)}</p>
    <p>Accedi qui: <a href="${loginUrl}">${loginUrl}</a></p>
    <p>Ti consigliamo di conservare questa password in un posto sicuro; non viene mostrata di nuovo.</p>
    <p>&mdash; GioAviation.aero</p>
  `;

  await sendEmail(env, {
    to: email,
    subject: "Il tuo accesso a GioAviation.aero è stato approvato",
    html,
  });
}

// Best-effort: a pilot submitting the access-request form should not fail
// just because the admin notification email didn't go out. Errors here are
// swallowed (not surfaced to the pilot) — admin.html remains the source of
// truth for pending requests either way.
async function notifyAdminOfNewRequest(env, { email, fullName, company, note }) {
  if (!env.ADMIN_NOTIFY_EMAIL) return;

  const html = `
    <p>Nuova richiesta di accesso su GioAviation.aero:</p>
    <p><strong>Nome:</strong> ${escapeHtml(fullName)}<br>
    <strong>Email:</strong> ${escapeHtml(email)}<br>
    <strong>Compagnia:</strong> ${escapeHtml(company || "—")}<br>
    <strong>Nota:</strong> ${escapeHtml(note || "—")}</p>
    <p>Approva o rifiuta da <a href="https://gioaviation.aero/admin.html">admin.html</a>.</p>
  `;

  try {
    await sendEmail(env, {
      to: env.ADMIN_NOTIFY_EMAIL,
      subject: `Nuova richiesta di accesso — ${fullName}`,
      html,
    });
  } catch (e) {
    // Intentionally not rethrown — see comment above.
  }
}

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

  const from = env.RESEND_FROM || "GioAviation.com <access@gioaviation.com>";

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Resend error ${resp.status}: ${text}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// -------------------------------------------------------------- sessions --

async function createSessionCookie(env, payload) {
  const token = await signToken(env, payload);
  const maxAge = Math.max(1, Math.floor((payload.exp - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function getSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;

  const payload = await verifyToken(env, match[1]);
  if (!payload) return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

async function signToken(env, payload) {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(env, body);
  return `${body}.${sig}`;
}

async function verifyToken(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmacSign(env, body);
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch (e) {
    return null;
  }
}

async function hmacSign(env, data) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

// -------------------------------------------------------------- passwords --

async function hashPassword(password, existingSaltB64) {
  const salt = existingSaltB64 ? base64Decode(existingSaltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    keyMaterial,
    256
  );
  return { hash: base64Encode(new Uint8Array(bits)), salt: base64Encode(salt) };
}

function generatePassword() {
  // Avoids visually ambiguous characters (0/O, 1/I/l).
  const charset = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += charset[b % charset.length];
  return out;
}

// --------------------------------------------------------------- helpers --

async function safeJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function json(payload, status, extraHeaders) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

function timingSafeEqualStr(a, b) {
  const bufA = new TextEncoder().encode(String(a || ""));
  const bufB = new TextEncoder().encode(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

function base64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64Encode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64Decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
