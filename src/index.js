// GioAviation.aero — Worker entry point.
//
// Handles:
//  - Access control: only a short public allow-list is served without a
//    session (home, request-access, login, public articles); everything
//    else (resources, contatti, credenziali, profilo) requires a logged-in
//    pilot session, and /admin*.html + /api/admin/* require an admin
//    session.
//  - Pilot self-service: POST /api/request-access (queues a pending row),
//    POST /api/login, GET /api/logout, POST /api/activate (sets the
//    pilot's own password from an emailed activation link),
//    GET/POST /api/profile (mandatory profile completion at first login).
//  - Admin workflow: POST /api/admin/login, GET /api/admin/requests,
//    POST /api/admin/approve, POST /api/admin/reject, POST /api/admin/delete,
//    POST /api/admin/resend-activation, GET /api/admin/logout.
//    Approving generates an activation token (not a password), stores its
//    hash, and emails the pilot an activation link via Resend; the pilot
//    then chooses their own password on /imposta-password.html.
//  - Content: public Markdown articles (GET /api/articles[?slug=]),
//    admin-managed categories shared between articles and documents
//    (kind='article'|'document'), and a gated PDF library stored in
//    Cloudflare R2 (binding DOCS) with metadata in D1 — admin uploads via
//    POST /api/admin/documents/upload (multipart/form-data), pilots list
//    via GET /api/documents and download via GET /api/documents/download.
//
// Required bindings (Worker → Settings → Bindings / Variables & Secrets):
//   DB                 D1 database bound as "DB" (schema.sql + migration-002)
//   DOCS               R2 bucket bound as "DOCS" (gioaviation-documents) —
//     create the bucket once in the Cloudflare dashboard (R2 → Create
//     bucket), the binding is already declared in wrangler.jsonc.
//   SESSION_SECRET     secret, long random string — signs session cookies
//   ADMIN_PASSWORD     secret — the single admin password for /admin.html
//   RESEND_API_KEY     secret — from resend.com, used to send email
//   RESEND_FROM        var    — e.g. "GioAviation.com <access@gioaviation.com>"
//     (the domain in RESEND_FROM must be verified in your Resend account —
//     as of now only gioaviation.com is verified there, not gioaviation.aero)
//   ADMIN_NOTIFY_EMAIL var    — where to send "new access request" notices.
//     Optional: if unset, new requests are simply not notified by email —
//     you'd only see them by opening admin.html.
//
// Migration: run migration-002-backend.sql once (same way as schema.sql —
// Cloudflare dashboard → D1 → gioaviation-db → Console, paste and run, or
// `wrangler d1 execute gioaviation-db --file=migration-002-backend.sql`)
// before deploying this file, or every request will fail on the new columns.

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
  "/imposta-password.html",
  "/imposta-password",
  "/articoli.html",
  "/articoli",
  "/articolo.html",
  "/articolo",
]);

// Pilot pages reachable even before the mandatory profile is completed.
// Everything else under the pilot-session branch redirects to profilo.html
// until the profile is filled in.
const PROFILE_EXEMPT_PATHS = new Set(["/profilo.html", "/profilo"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      return handleApi(request, env, path, url);
    }

    if (PUBLIC_PATHS.has(path) || path.startsWith("/assets/")) {
      return env.ASSETS.fetch(request);
    }

    if (path === "/admin.html" || path === "/admin" || ADMIN_PAGES.has(path)) {
      const session = await getSession(request, env);
      if (!session || session.role !== "admin") {
        return Response.redirect(new URL("/admin-login.html", url), 302);
      }
      return env.ASSETS.fetch(request);
    }

    // Everything else (risorse.html, contatti.html, credenziali.html,
    // profilo.html, resources/*) requires a logged-in pilot (or admin).
    const session = await getSession(request, env);
    if (!session) {
      const to = new URL("/login.html", url);
      to.searchParams.set("next", path);
      return Response.redirect(to, 302);
    }

    // A pilot (not an admin browsing the site) must complete their profile
    // before reaching anything else.
    if (session.role === "pilot" && !PROFILE_EXEMPT_PATHS.has(path)) {
      const pilot = await env.DB.prepare("SELECT profile_completed FROM pilots WHERE id = ?")
        .bind(session.id).first();
      if (!pilot || !pilot.profile_completed) {
        const toProfile = new URL("/profilo.html", url);
        toProfile.searchParams.set("next", path);
        return Response.redirect(toProfile, 302);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

const ADMIN_PAGES = new Set([
  "/admin-categorie.html", "/admin-categorie",
  "/admin-articoli.html", "/admin-articoli",
  "/admin-documenti.html", "/admin-documenti",
]);

// ---------------------------------------------------------------- routing --

async function handleApi(request, env, path, url) {
  const method = request.method;

  if (path === "/api/request-access" && method === "POST") return apiRequestAccess(request, env);
  if (path === "/api/login" && method === "POST") return apiLogin(request, env);
  if (path === "/api/logout") return apiLogout();
  if (path === "/api/activate" && method === "POST") return apiActivate(request, env);

  if (path === "/api/admin/login" && method === "POST") return apiAdminLogin(request, env);
  if (path === "/api/admin/logout") return apiLogout();

  if (path === "/api/admin/requests" && method === "GET") return apiAdminList(request, env);
  if (path === "/api/admin/approve" && method === "POST") return apiAdminApprove(request, env);
  if (path === "/api/admin/reject" && method === "POST") return apiAdminReject(request, env);
  if (path === "/api/admin/delete" && method === "POST") return apiAdminDelete(request, env);
  if (path === "/api/admin/resend-activation" && method === "POST") return apiAdminResendActivation(request, env);

  // -- profile (pilot) --
  if (path === "/api/profile" && method === "GET") return apiProfileGet(request, env);
  if (path === "/api/profile" && method === "POST") return apiProfileSave(request, env);

  // -- public articles --
  if (path === "/api/articles" && method === "GET") return apiArticlesPublicList(request, env, url);

  // -- admin: categories --
  if (path === "/api/admin/categories" && method === "GET") return apiAdminCategoriesList(request, env);
  if (path === "/api/admin/categories/save" && method === "POST") return apiAdminCategorySave(request, env);
  if (path === "/api/admin/categories/delete" && method === "POST") return apiAdminCategoryDelete(request, env);

  // -- admin: articles --
  if (path === "/api/admin/articles" && method === "GET") return apiAdminArticlesList(request, env);
  if (path === "/api/admin/articles/save" && method === "POST") return apiAdminArticleSave(request, env);
  if (path === "/api/admin/articles/delete" && method === "POST") return apiAdminArticleDelete(request, env);

  // -- admin: documents --
  if (path === "/api/admin/documents" && method === "GET") return apiAdminDocumentsList(request, env);
  if (path === "/api/admin/documents/upload" && method === "POST") return apiAdminDocumentUpload(request, env);
  if (path === "/api/admin/documents/save" && method === "POST") return apiAdminDocumentSave(request, env);
  if (path === "/api/admin/documents/delete" && method === "POST") return apiAdminDocumentDelete(request, env);

  // -- pilot: documents --
  if (path === "/api/documents" && method === "GET") return apiDocumentsList(request, env);
  if (path === "/api/documents/download" && method === "GET") return apiDocumentDownload(request, env, url);

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
    `SELECT id, email, full_name, company, note, status, created_at, approved_at,
            (password_hash IS NOT NULL) AS activated, profile_completed
     FROM pilots ORDER BY created_at DESC`
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

  // The pilot sets their own password via an emailed activation link —
  // nothing secret is ever generated here or put in plaintext in an email.
  const { token, tokenHash, expiresAt } = await createActivationToken();

  await env.DB.prepare(
    "UPDATE pilots SET status = 'approved', activation_token_hash = ?, activation_expires = ?, approved_at = ? WHERE id = ?"
  ).bind(tokenHash, expiresAt, new Date().toISOString(), id).run();

  let emailSent = false;
  let emailError = null;
  try {
    await sendActivationEmail(env, { email: pilot.email, fullName: pilot.full_name, token });
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

async function apiAdminDelete(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  const id = body && Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  await env.DB.prepare("DELETE FROM pilots WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// A pilot can be "approved" but never click the emailed link (spam filter,
// typo, link expired after 7 days). This re-issues a fresh token/email
// without touching their status or any password they may already have set.
async function apiAdminResendActivation(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  const id = body && Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const pilot = await env.DB.prepare("SELECT id, email, full_name, status FROM pilots WHERE id = ?").bind(id).first();
  if (!pilot) return json({ ok: false, error: "not_found" }, 404);
  if (pilot.status !== "approved") return json({ ok: false, error: "not_approved" }, 409);

  const { token, tokenHash, expiresAt } = await createActivationToken();
  await env.DB.prepare("UPDATE pilots SET activation_token_hash = ?, activation_expires = ? WHERE id = ?")
    .bind(tokenHash, expiresAt, id).run();

  let emailSent = false;
  let emailError = null;
  try {
    await sendActivationEmail(env, { email: pilot.email, fullName: pilot.full_name, token });
    emailSent = true;
  } catch (e) {
    emailError = String(e && e.message ? e.message : e);
  }
  return json({ ok: true, email_sent: emailSent, email_error: emailError });
}

// -------------------------------------------------------- pilot: activate --
// Sets the pilot's own password from the token emailed after admin approval,
// then logs them straight in (so the next stop is the mandatory profile).

async function apiActivate(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const token = String(body.token || "");
  const password = String(body.password || "");
  if (!token) return json({ ok: false, error: "missing_token" }, 400);
  if (password.length < 8) return json({ ok: false, error: "weak_password" }, 400);

  const tokenHash = await sha256Hex(token);
  const pilot = await env.DB.prepare(
    "SELECT id, email, activation_expires FROM pilots WHERE activation_token_hash = ? AND status = 'approved'"
  ).bind(tokenHash).first();

  if (!pilot) return json({ ok: false, error: "invalid_token" }, 400);
  if (!pilot.activation_expires || new Date(pilot.activation_expires).getTime() < Date.now()) {
    return json({ ok: false, error: "expired_token" }, 400);
  }

  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    "UPDATE pilots SET password_hash = ?, password_salt = ?, activation_token_hash = NULL, activation_expires = NULL WHERE id = ?"
  ).bind(hash, salt, pilot.id).run();

  const cookie = await createSessionCookie(env, {
    role: "pilot",
    id: pilot.id,
    email: pilot.email,
    exp: Date.now() + PILOT_SESSION_DAYS * 86400000,
  });

  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}

async function createActivationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = base64UrlEncode(bytes);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  return { token, tokenHash, expiresAt };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------- pilot: profile --

async function requirePilot(request, env) {
  const session = await getSession(request, env);
  return session && (session.role === "pilot" || session.role === "admin") ? session : null;
}

async function apiProfileGet(request, env) {
  const session = await requirePilot(request, env);
  if (!session || session.role !== "pilot") return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const pilot = await env.DB.prepare(
    "SELECT first_name, last_name, birth_year, role, total_hours, profile_completed FROM pilots WHERE id = ?"
  ).bind(session.id).first();
  return json({ ok: true, profile: pilot || null });
}

async function apiProfileSave(request, env) {
  const session = await requirePilot(request, env);
  if (!session || session.role !== "pilot") return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);

  const firstName = String(body.first_name || "").trim();
  const lastName = String(body.last_name || "").trim();
  const birthYear = Number(body.birth_year);
  const role = String(body.role || "").trim();
  const hasHours = body.total_hours !== null && body.total_hours !== undefined && body.total_hours !== "";
  const totalHours = hasHours ? Number(body.total_hours) : null;

  const currentYear = new Date().getFullYear();
  if (!firstName) return json({ ok: false, error: "missing_first_name" }, 400);
  if (!lastName) return json({ ok: false, error: "missing_last_name" }, 400);
  if (!role) return json({ ok: false, error: "missing_role" }, 400);
  if (!Number.isInteger(birthYear) || birthYear < 1930 || birthYear > currentYear - 16) {
    return json({ ok: false, error: "invalid_birth_year" }, 400);
  }
  if (hasHours && (!Number.isFinite(totalHours) || totalHours < 0)) {
    return json({ ok: false, error: "invalid_total_hours" }, 400);
  }

  await env.DB.prepare(
    "UPDATE pilots SET first_name = ?, last_name = ?, birth_year = ?, role = ?, total_hours = ?, profile_completed = 1 WHERE id = ?"
  ).bind(firstName, lastName, birthYear, role, totalHours, session.id).run();

  return json({ ok: true });
}

// ---------------------------------------------------------------- articles --
// Public: Markdown articles, no session required. Rendering the Markdown to
// HTML happens client-side (articolo.html loads a small library from a
// CDN) — the Worker only ever hands out the raw title/excerpt/markdown, so
// this file stays a single dependency-free script with no build step.

async function apiArticlesPublicList(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);
  const slug = url.searchParams.get("slug");

  if (slug) {
    const article = await env.DB.prepare(
      `SELECT a.id, a.slug, a.title, a.excerpt, a.body_markdown, a.published_at, c.name AS category_name, c.slug AS category_slug
       FROM articles a LEFT JOIN categories c ON c.id = a.category_id
       WHERE a.slug = ? AND a.status = 'published'`
    ).bind(slug).first();
    if (!article) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, article });
  }

  const categorySlug = url.searchParams.get("category");
  let query = `SELECT a.id, a.slug, a.title, a.excerpt, a.published_at, c.name AS category_name, c.slug AS category_slug
               FROM articles a LEFT JOIN categories c ON c.id = a.category_id
               WHERE a.status = 'published'`;
  const params = [];
  if (categorySlug) {
    query += " AND c.slug = ?";
    params.push(categorySlug);
  }
  query += " ORDER BY a.published_at DESC";

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ ok: true, articles: results });
}

async function apiAdminArticlesList(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  // body_markdown is included even in the list response (not just when
  // editing a single article) — articles are short text, not PDFs, so the
  // admin editor can always reload a draft's full text without a second
  // endpoint.
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.slug, a.title, a.excerpt, a.body_markdown, a.status, a.created_at, a.updated_at, a.published_at,
            a.category_id, c.name AS category_name
     FROM articles a LEFT JOIN categories c ON c.id = a.category_id
     ORDER BY a.updated_at DESC`
  ).all();
  return json({ ok: true, articles: results });
}

async function apiAdminArticleSave(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);

  const title = String(body.title || "").trim();
  const bodyMarkdown = String(body.body_markdown || "");
  const excerpt = String(body.excerpt || "").trim() || null;
  const status = body.status === "published" ? "published" : "draft";
  const categoryId = body.category_id ? Number(body.category_id) : null;
  let slug = String(body.slug || "").trim();

  if (!title) return json({ ok: false, error: "missing_title" }, 400);
  if (!bodyMarkdown.trim()) return json({ ok: false, error: "missing_body" }, 400);
  if (!slug) slug = slugify(title);
  slug = slugify(slug);
  if (!slug) return json({ ok: false, error: "invalid_slug" }, 400);

  const now = new Date().toISOString();
  const id = body.id ? Number(body.id) : null;

  const clash = await env.DB.prepare("SELECT id FROM articles WHERE slug = ? AND id IS NOT ?")
    .bind(slug, id || 0).first();
  if (clash) return json({ ok: false, error: "slug_taken" }, 409);

  if (id) {
    const existing = await env.DB.prepare("SELECT status, published_at FROM articles WHERE id = ?").bind(id).first();
    if (!existing) return json({ ok: false, error: "not_found" }, 404);
    const publishedAt = status === "published" ? (existing.published_at || now) : existing.published_at;
    await env.DB.prepare(
      `UPDATE articles SET category_id=?, slug=?, title=?, excerpt=?, body_markdown=?, status=?, updated_at=?, published_at=? WHERE id=?`
    ).bind(categoryId, slug, title, excerpt, bodyMarkdown, status, now, publishedAt, id).run();
    return json({ ok: true, id });
  }

  const publishedAt = status === "published" ? now : null;
  const result = await env.DB.prepare(
    `INSERT INTO articles (category_id, slug, title, excerpt, body_markdown, status, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(categoryId, slug, title, excerpt, bodyMarkdown, status, now, now, publishedAt).run();
  return json({ ok: true, id: result.meta.last_row_id });
}

async function apiAdminArticleDelete(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  const id = body && Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// -------------------------------------------------------------- categories --
// Shared between articles and documents; distinguished by `kind`.

async function apiAdminCategoriesList(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const { results } = await env.DB.prepare(
    "SELECT id, kind, name, slug, sort_order FROM categories ORDER BY kind, sort_order, name"
  ).all();
  return json({ ok: true, categories: results });
}

async function apiAdminCategorySave(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);

  const kind = body.kind === "article" ? "article" : "document";
  const name = String(body.name || "").trim();
  const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;
  let slug = slugify(String(body.slug || "").trim() || name);
  const id = body.id ? Number(body.id) : null;

  if (!name) return json({ ok: false, error: "missing_name" }, 400);
  if (!slug) return json({ ok: false, error: "invalid_slug" }, 400);

  const clash = await env.DB.prepare("SELECT id FROM categories WHERE kind = ? AND slug = ? AND id IS NOT ?")
    .bind(kind, slug, id || 0).first();
  if (clash) return json({ ok: false, error: "slug_taken" }, 409);

  if (id) {
    await env.DB.prepare("UPDATE categories SET name = ?, slug = ?, sort_order = ? WHERE id = ?")
      .bind(name, slug, sortOrder, id).run();
    return json({ ok: true, id });
  }

  const result = await env.DB.prepare(
    "INSERT INTO categories (kind, name, slug, sort_order, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(kind, name, slug, sortOrder, new Date().toISOString()).run();
  return json({ ok: true, id: result.meta.last_row_id });
}

async function apiAdminCategoryDelete(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  const id = body && Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  // Articles/documents in this category are kept, just unlinked (ON DELETE
  // SET NULL in the schema) — deleting a category never deletes content.
  await env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// -------------------------------------------------------------- documents --
// Metadata in D1, file bytes in R2 (binding DOCS). Only published documents
// are visible to pilots, and only once their profile is completed — the
// page-level gate in the default export already enforces the profile
// requirement for risorse.html; these two endpoints enforce it again
// independently, since /api/* bypasses that page-level gate entirely.

async function requirePilotWithProfile(request, env) {
  const session = await getSession(request, env);
  if (!session) return null;
  if (session.role === "admin") return session;
  if (session.role !== "pilot") return null;
  const pilot = await env.DB.prepare("SELECT profile_completed FROM pilots WHERE id = ?").bind(session.id).first();
  if (!pilot || !pilot.profile_completed) return null;
  return session;
}

async function apiDocumentsList(request, env) {
  const session = await requirePilotWithProfile(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const { results } = await env.DB.prepare(
    `SELECT d.id, d.title, d.description, d.file_name, d.file_size, d.revision_label, d.revision_date,
            d.category_id, c.name AS category_name, c.slug AS category_slug, c.sort_order AS category_sort
     FROM documents d LEFT JOIN categories c ON c.id = d.category_id
     WHERE d.status = 'published'
     ORDER BY c.sort_order, c.name, d.title`
  ).all();
  return json({ ok: true, documents: results });
}

async function apiDocumentDownload(request, env, url) {
  const session = await requirePilotWithProfile(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB || !env.DOCS) return json({ ok: false, error: "storage_not_configured" }, 500);

  const id = Number(url.searchParams.get("id"));
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const doc = await env.DB.prepare(
    "SELECT file_key, file_name, content_type FROM documents WHERE id = ? AND status = 'published'"
  ).bind(id).first();
  if (!doc) return json({ ok: false, error: "not_found" }, 404);

  const object = await env.DOCS.get(doc.file_key);
  if (!object) return json({ ok: false, error: "file_missing" }, 404);

  return new Response(object.body, {
    headers: {
      "Content-Type": doc.content_type || "application/pdf",
      "Content-Disposition": `attachment; filename="${doc.file_name.replace(/"/g, "")}"`,
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
    },
  });
}

async function apiAdminDocumentsList(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const { results } = await env.DB.prepare(
    `SELECT d.id, d.title, d.description, d.file_name, d.file_size, d.revision_label, d.revision_date,
            d.status, d.uploaded_at, d.category_id, c.name AS category_name
     FROM documents d LEFT JOIN categories c ON c.id = d.category_id
     ORDER BY d.uploaded_at DESC`
  ).all();
  return json({ ok: true, documents: results });
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB — comfortable for scanned manuals, well under R2/Worker limits

async function apiAdminDocumentUpload(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB || !env.DOCS) return json({ ok: false, error: "storage_not_configured" }, 500);

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ ok: false, error: "bad_request: " + (e && e.message) }, 400);
  }

  const file = form.get("file");
  const title = String(form.get("title") || "").trim();
  const description = String(form.get("description") || "").trim() || null;
  const categoryId = form.get("category_id") ? Number(form.get("category_id")) : null;
  const revisionLabel = String(form.get("revision_label") || "").trim() || null;
  const revisionDate = String(form.get("revision_date") || "").trim() || null;
  const status = form.get("status") === "published" ? "published" : "draft";

  if (!file || typeof file === "string") return json({ ok: false, error: "missing_file" }, 400);
  if (!title) return json({ ok: false, error: "missing_title" }, 400);
  if (file.type && file.type !== "application/pdf") return json({ ok: false, error: "pdf_only" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ ok: false, error: "file_too_large" }, 400);

  const key = `documents/${crypto.randomUUID()}.pdf`;
  try {
    await env.DOCS.put(key, file, {
      httpMetadata: { contentType: "application/pdf" },
    });
  } catch (e) {
    return json({ ok: false, error: "r2: " + (e && e.message) }, 500);
  }

  let result;
  try {
  result = await env.DB.prepare(
    `INSERT INTO documents (category_id, title, description, file_key, file_name, file_size, content_type, revision_label, revision_date, status, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    categoryId, title, description, key, file.name || `${title}.pdf`, file.size,
    file.type || "application/pdf", revisionLabel, revisionDate, status, new Date().toISOString()
  ).run();
  } catch (e) {
    try { await env.DOCS.delete(key); } catch (_) {}
    return json({ ok: false, error: "db: " + (e && e.message) }, 500);
  }

  return json({ ok: true, id: result.meta.last_row_id });
}

async function apiAdminDocumentSave(request, env) {
  // Metadata-only edit — replacing the PDF itself means deleting and
  // re-uploading, to keep this endpoint (and R2 key handling) simple.
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  if (!body) return json({ ok: false, error: "bad_request" }, 400);
  const id = Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const title = String(body.title || "").trim();
  if (!title) return json({ ok: false, error: "missing_title" }, 400);
  const description = String(body.description || "").trim() || null;
  const categoryId = body.category_id ? Number(body.category_id) : null;
  const revisionLabel = String(body.revision_label || "").trim() || null;
  const revisionDate = String(body.revision_date || "").trim() || null;
  const status = body.status === "published" ? "published" : "draft";

  await env.DB.prepare(
    `UPDATE documents SET title=?, description=?, category_id=?, revision_label=?, revision_date=?, status=? WHERE id=?`
  ).bind(title, description, categoryId, revisionLabel, revisionDate, status, id).run();
  return json({ ok: true });
}

async function apiAdminDocumentDelete(request, env) {
  if (!(await requireAdmin(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "db_not_configured" }, 500);

  const body = await safeJson(request);
  const id = body && Number(body.id);
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const doc = await env.DB.prepare("SELECT file_key FROM documents WHERE id = ?").bind(id).first();
  if (doc && env.DOCS) {
    try { await env.DOCS.delete(doc.file_key); } catch (e) { /* best-effort */ }
  }
  await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------ email --

async function sendActivationEmail(env, { email, fullName, token }) {
  const activateUrl = `https://gioaviation.aero/imposta-password.html?token=${encodeURIComponent(token)}`;

  const html = `
    <p>Hello ${escapeHtml(fullName)},</p>
    <p>Your access to GioAviation.aero has been approved. To finish setting up your account, choose your own password here:</p>
    <p><a href="${activateUrl}">${activateUrl}</a></p>
    <p>This link expires in 7 days. After setting your password you'll be asked to complete a short profile before reaching the resource library.</p>
    <p>&mdash; GioAviation.aero</p>
  `;

  await sendEmail(env, {
    to: email,
    subject: "Set your password — GioAviation.aero access approved",
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
    <p>New access request on GioAviation.aero:</p>
    <p><strong>Name:</strong> ${escapeHtml(fullName)}<br>
    <strong>Email:</strong> ${escapeHtml(email)}<br>
    <strong>Company:</strong> ${escapeHtml(company || "—")}<br>
    <strong>Details:</strong><br>${escapeHtml(note || "—").replace(/\n/g, "<br>")}</p>
    <p>Approve or reject from <a href="https://gioaviation.aero/admin.html">admin.html</a>.</p>
  `;

  try {
    await sendEmail(env, {
      to: env.ADMIN_NOTIFY_EMAIL,
      subject: `New access request — ${fullName}`,
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
