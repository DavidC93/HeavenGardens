import { db } from "./_lib/db.mjs";
import { requireAdmin } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import { clientIp, rateLimit } from "./_lib/ratelimit.mjs";
import { httpError } from "./_lib/economy.mjs";
import { deleteDeck, listDecks, loadLevels, publicAiConfig, saveDeck, saveLevels } from "./_lib/aidecks.mjs";

/**
 * The computer opponent.
 *   GET                       (anyone)  { levels: [{ level, maxGames, deck }] }   what the app plays with
 *   GET ?admin=1              (admins)  { levels: [{ level, maxGames, deckId }], decks: [{ id, name, config }] }
 *   POST { action: "saveDeck", id?, name, config }   (admins) -> { id }
 *   POST { action: "deleteDeck", id }                (admins)
 *   POST { action: "saveLevels", levels }            (admins) -> { levels }
 */
export async function handler(event) {
  try {
    const sql = db();
    if (event.httpMethod === "GET") {
      if (event.queryStringParameters?.admin) {
        await requireAdmin(event);
        const [levels, decks] = await Promise.all([loadLevels(sql), listDecks(sql)]);
        return json(200, { levels, decks });
      }
      await rateLimit("appStatus", clientIp(event), sql);
      return json(200, await publicAiConfig(sql));
    }
    if (event.httpMethod !== "POST") return methodNotAllowed(["GET", "POST"]);
    const admin = await requireAdmin(event);
    const body = await readJson(event);
    switch (body.action) {
      case "saveDeck": return json(200, { id: await saveDeck(sql, body, admin.id) });
      case "deleteDeck": await deleteDeck(sql, body.id, admin.id); return json(200, { ok: true });
      case "saveLevels": return json(200, { levels: await saveLevels(sql, body, admin.id) });
      default: throw httpError(400, "unknown_action");
    }
  } catch (error) {
    return handleError(error);
  }
}
