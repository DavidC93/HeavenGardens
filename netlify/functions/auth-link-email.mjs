import { db } from "./_lib/db.mjs";
import { normalizeEmail, passwordHash, requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";
import { userWithProviders } from "./_lib/accounts.mjs";

/**
 * Adds an email and password to an account that was created with a platform sign-in (e.g. Google Play), so the
 * same account can also be used where that platform is not available (another phone, iOS later).
 *   POST { email, password }
 */
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const user = await requireUser(event);
    const sql = db();
    await rateLimit("register", clientIp(event), sql);
    const body = await readJson(event);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    if (!email.includes("@")) return json(400, { error: "invalid_email" });
    if (password.length < 8) return json(400, { error: "weak_password", message: "Password must be at least 8 characters." });
    if (user.email) return json(409, { error: "email_already_set" });

    try {
      const rows = await sql`
        update app_users set email = ${email}, password_hash = ${passwordHash(password)}, updated_at = now()
        where id = ${user.id} and email is null
        returning id
      `;
      if (rows.length === 0) return json(409, { error: "email_already_set" });
    } catch (error) {
      if (String(error.message || "").includes("duplicate key")) return json(409, { error: "email_exists" });
      throw error;
    }
    return json(200, { user: await userWithProviders(sql, user.id) });
  } catch (error) {
    return handleError(error);
  }
}
