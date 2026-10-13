import { db } from "./_lib/db.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";
import { playGamesPlayer } from "./_lib/google.mjs";
import { signInWithIdentity } from "./_lib/accounts.mjs";

/**
 * Sign in with a platform account (Google Play Games now; Apple later).
 *   POST { provider: "google_play", authCode }            sign in, creating an account the first time
 *   POST { provider: "google_play", authCode, link: true } add Google Play to the account that is signed in now
 * The auth code is exchanged with Google on the server, so the player id cannot be faked by the app.
 */
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return methodNotAllowed(["POST"]);
    const sql = db();
    await rateLimit("platformLogin", clientIp(event), sql);
    const body = await readJson(event);
    if (body.provider !== "google_play") return json(400, { error: "unknown_provider" });

    const player = await playGamesPlayer(body.authCode);
    return json(...await signInWithIdentity(sql, event, "google_play", player.playerId, player.displayName, body.link === true));
  } catch (error) {
    return handleError(error);
  }
}
