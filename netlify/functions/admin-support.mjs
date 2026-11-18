import { db } from "./_lib/db.mjs";
import { requireAdmin } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";

/**
 * Back office: messages to support (admins only).
 *   GET  ?status=open|done|all   the newest 200, with the sender's account (nickname, email) when they were signed in
 *   POST { id, status: "open" | "done" }   marks a message handled (or open again)
 */
export async function handler(event) {
  try {
    const admin = await requireAdmin(event);
    const sql = db();
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      const status = ["open", "done"].includes(q.status) ? q.status : null;
      const rows = await sql`
        select s.id, s.name, s.email, s.message, s.app_version, s.platform, s.device, s.language, s.status, s.created_at,
          s.handled_at, s.user_id, u.nickname, u.email as account_email, h.email as handled_by_email
        from support_requests s
        left join app_users u on u.id = s.user_id
        left join app_users h on h.id = s.handled_by
        where ${status}::text is null or s.status = ${status}
        order by s.created_at desc
        limit 200
      `;
      const [counts] = await sql`select count(*) filter (where status = 'open')::int as open, count(*)::int as all from support_requests`;
      return json(200, { requests: rows.map(r => ({ ...r, id: Number(r.id) })), counts });
    }
    if (event.httpMethod === "POST") {
      const body = await readJson(event);
      const id = Number(body.id);
      const status = body.status === "done" ? "done" : body.status === "open" ? "open" : null;
      if (!Number.isInteger(id) || id <= 0 || !status) return json(400, { error: "bad_request" });
      const rows = await sql`
        update support_requests set status = ${status},
          handled_by = case when ${status} = 'done' then ${admin.id}::uuid else null end,
          handled_at = case when ${status} = 'done' then now() else null end
        where id = ${id} returning id
      `;
      if (!rows.length) return json(404, { error: "not_found" });
      return json(200, { ok: true });
    }
    return methodNotAllowed(["GET", "POST"]);
  } catch (error) {
    return handleError(error);
  }
}
