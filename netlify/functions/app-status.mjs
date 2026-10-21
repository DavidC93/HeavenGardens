import { db } from "./_lib/db.mjs";
import { requireAdmin } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";
import { clientVersions, saveClientVersions } from "./_lib/appconfig.mjs";

/**
 * Which app builds may play.
 *   GET                                                   (anyone) { versions: { android: { min, recommended } } }
 *   POST { versions: { android: { min, recommended } } }  (admins) saves them
 */
export async function handler(event) {
  try {
    const sql = db();
    if (event.httpMethod === "GET") {
      await rateLimit("appStatus", clientIp(event), sql);
      return json(200, { versions: await clientVersions(sql) });
    }
    if (event.httpMethod !== "POST") return methodNotAllowed(["GET", "POST"]);
    const admin = await requireAdmin(event);
    const body = await readJson(event);
    return json(200, { versions: await saveClientVersions(sql, body.versions, admin.id) });
  } catch (error) {
    return handleError(error);
  }
}
