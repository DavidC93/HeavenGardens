import { db } from "./_lib/db.mjs";
import { passwordHash, sha256 } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);

    const body = await readJson(event);
    const token = String(body.token || "");
    const password = String(body.password || "");
    if (password.length < 8) return json(400, { error: "weak_password" });

    const sql = db();
    const rows = await sql`
      select id, user_id
      from password_reset_tokens
      where token_hash = ${sha256(token)}
        and expires_at > now()
        and used_at is null
      limit 1
    `;
    const reset = rows[0];
    if (!reset) return json(400, { error: "invalid_or_expired_token" });

    await sql`update app_users set password_hash = ${passwordHash(password)} where id = ${reset.user_id}`;
    await sql`update password_reset_tokens set used_at = now() where id = ${reset.id}`;
    await sql`delete from user_sessions where user_id = ${reset.user_id}`;

    return json(200, { ok: true });
  } catch (error) {
    return handleError(error);
  }
}

