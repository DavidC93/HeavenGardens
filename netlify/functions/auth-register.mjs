import { db } from "./_lib/db.mjs";
import { createSession, normalizeEmail, passwordHash, sessionCookie } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);

    const body = await readJson(event);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const displayName = String(body.displayName || email.split("@")[0] || "Player").trim();

    if (!email.includes("@")) return json(400, { error: "invalid_email" });
    if (password.length < 8) return json(400, { error: "weak_password", message: "Password must be at least 8 characters." });

    const sql = db();
    const userCountRows = await sql`select count(*)::int as count from app_users`;
    const role = userCountRows[0]?.count === 0 ? "admin" : "user";

    const rows = await sql`
      insert into app_users (email, display_name, password_hash, role)
      values (${email}, ${displayName}, ${passwordHash(password)}, ${role})
      returning id, email, display_name, role
    `;

    const session = await createSession(rows[0].id);
    return json(201, { user: rows[0] }, { "set-cookie": sessionCookie(session.token, session.expiresAt) });
  } catch (error) {
    if (String(error.message || "").includes("duplicate key")) {
      return json(409, { error: "email_exists" });
    }
    return handleError(error);
  }
}

