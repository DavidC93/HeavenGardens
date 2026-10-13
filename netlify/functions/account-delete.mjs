import { db } from "./_lib/db.mjs";
import { clearSessionCookie, requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { rateLimit } from "./_lib/ratelimit.mjs";

/**
 * Deletes the signed-in account and everything stored for it: sessions, sign-in methods, wallet, collection,
 * shards, decks, rewards and history (all tables cascade from app_users). Purchase records stay, without the
 * player, as the record of a payment. Required by Google Play for apps that let players create an account.
 *   POST { confirm: "DELETE" }
 */
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const user = await requireUser(event);
    const sql = db();
    await rateLimit("accountDelete", user.id, sql);
    const body = await readJson(event);
    if (body.confirm !== "DELETE") return json(400, { error: "confirmation_required" });

    await sql`delete from app_users where id = ${user.id}`;
    console.log("account deleted", user.id);
    return json(200, { ok: true }, { "set-cookie": clearSessionCookie() });
  } catch (error) {
    return handleError(error);
  }
}
