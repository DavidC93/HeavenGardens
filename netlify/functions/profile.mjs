import { db } from "./_lib/db.mjs";
import { requireUser } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed } from "./_lib/http.mjs";
import { rateLimit } from "./_lib/ratelimit.mjs";
import { loadRanks } from "./_lib/ranks.mjs";
import { myStats, publicProfile } from "./_lib/stats.mjs";

/**
 * Statistics and profiles (signed-in players).
 *   GET              the player's own statistics: games by kind, wins, streaks, rank, collection, recent games
 *   GET ?user=<id>   another player's public profile (nickname, rank, record, collection size, friend id)
 */
export async function handler(event) {
  try {
    if (event.httpMethod !== "GET") return methodNotAllowed(["GET"]);
    const sql = db();
    const user = await requireUser(event);
    await rateLimit("profile", user.id, sql);
    const cfg = await loadRanks(sql);
    const target = event.queryStringParameters?.user;
    if (target) return json(200, { profile: await publicProfile(sql, cfg, target) });
    return json(200, { stats: await myStats(sql, cfg, user.id) });
  } catch (error) {
    return handleError(error);
  }
}
