import { db } from "./_lib/db.mjs";
import { clearSessionCookie, getCookie, SESSION_COOKIE, sha256 } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed } from "./_lib/http.mjs";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const token = getCookie(event, SESSION_COOKIE);
    if (token) await db()`delete from user_sessions where token_hash = ${sha256(token)}`;
    return json(200, { ok: true }, { "set-cookie": clearSessionCookie() });
  } catch (error) {
    return handleError(error);
  }
}

