import { db } from "./_lib/db.mjs";
import { createSession, normalizeEmail, sessionCookie, verifyPassword } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);

    const body = await readJson(event);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const sql = db();
    const rows = await sql`
      select id, email, display_name, password_hash, role
      from app_users
      where email = ${email}
      limit 1
    `;

    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return json(401, { error: "invalid_credentials" });
    }

    const session = await createSession(user.id);
    delete user.password_hash;
    return json(200, { user }, { "set-cookie": sessionCookie(session.token, session.expiresAt) });
  } catch (error) {
    return handleError(error);
  }
}

