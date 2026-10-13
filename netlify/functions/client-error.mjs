import { db } from "./_lib/db.mjs";
import { currentUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";

/**
 * Errors and exceptions reported by the app (signed in or not).
 *   POST { appVersion, platform, device, errors: [{ kind, message, stack, count }] }   at most 10 per request
 */
const cut = (value, n) => (value == null ? null : String(value).slice(0, n));

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const sql = db();
    await rateLimit("clientError", clientIp(event), sql);
    const body = await readJson(event);
    const errors = Array.isArray(body.errors) ? body.errors.slice(0, 10) : [];
    if (errors.length === 0) return json(400, { error: "no_errors" });
    let userId = null;
    try { userId = (await currentUser(event))?.id || null; } catch { /* reporting works signed out too */ }

    const rows = errors.map(e => ({
      kind: cut(e.kind || "exception", 40),
      message: cut(e.message || "(no message)", 1000),
      stack: cut(e.stack, 6000),
      count: Math.max(1, Math.min(10_000, Math.floor(Number(e.count) || 1)))
    }));
    await sql`
      insert into client_errors (user_id, app_version, platform, device, kind, message, stack, count)
      select ${userId}, ${cut(body.appVersion, 40)}, ${cut(body.platform, 40)}, ${cut(body.device, 120)}, x.kind, x.message, x.stack, x.count
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(kind text, message text, stack text, count int)
    `;
    if (Math.random() < 0.02) await sql`delete from client_errors where created_at < now() - interval '90 days'`;
    return json(200, { ok: true });
  } catch (error) {
    return handleError(error);
  }
}
