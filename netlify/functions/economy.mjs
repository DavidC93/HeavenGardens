import { currentUser, requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";
import {
  adminGrant, craft, db, disenchant, ensureStarter, httpError, loadState, openPack, publicConfig, rewardMatch
} from "./_lib/economy.mjs";

/**
 * Economy API.
 *   GET  /economy?config=1         public: packs, odds, rewards, starter collection
 *   GET  /economy                  signed in: wallet, collection and shards (grants the starter set on first visit)
 *   POST /economy {action: ...}    openPack {pack} | disenchant {cardId, amount} | craft {cardId}
 *                                  | reward {mode, result, turns, matchKey} | grant {coins, apples} (admin)
 * Every response to a signed-in request carries the new state, so the app always shows the server's numbers.
 */
export async function handler(event) {
  try {
    if (event.httpMethod === "GET" && event.queryStringParameters?.config) {
      return json(200, { config: publicConfig() });
    }

    const user = await requireUser(event);
    const sql = db();
    await ensureStarter(sql, user.id);

    if (event.httpMethod === "GET") {
      return json(200, { config: publicConfig(), state: await loadState(sql, user.id) });
    }
    if (event.httpMethod !== "POST") return methodNotAllowed(["GET", "POST"]);

    const body = await readJson(event);
    let result = {};
    switch (body.action) {
      case "openPack":
        result = { cards: await openPack(sql, user.id, String(body.pack || "")) };
        break;
      case "disenchant":
        result = await disenchant(sql, user.id, String(body.cardId || ""), body.amount);
        break;
      case "craft":
        result = await craft(sql, user.id, String(body.cardId || ""));
        break;
      case "reward":
        result = await rewardMatch(sql, user.id, body);
        break;
      case "grant": {
        const me = await currentUser(event);
        if (me?.role !== "admin") throw httpError(403, "admin_required");
        await adminGrant(sql, user.id, body);
        break;
      }
      default:
        throw httpError(400, "unknown_action");
    }
    return json(200, { ...result, state: await loadState(sql, user.id) });
  } catch (error) {
    return handleError(error);
  }
}
