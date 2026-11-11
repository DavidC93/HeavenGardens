// Online ranked games, statistics and profiles against a TEST database branch (never production):
//   DATABASE_URL=<test branch> node scripts/online-test.mjs
import { neon } from "@neondatabase/serverless";
import { ensureStarter, rewardMatch } from "../netlify/functions/_lib/economy.mjs";
import { leaderboard, loadRank, normalizeRanks, publicStatus, reportMatch, setNickname, startMatch } from "../netlify/functions/_lib/ranks.mjs";
import { myStats, publicProfile } from "../netlify/functions/_lib/stats.mjs";

const sql = neon(process.env.DATABASE_URL);
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const code = p => p.then(() => null, e => e.publicCode);
const cfg = normalizeRanks(null);
const stamp = Date.now();
const users = [];
const newUser = async name => {
  const [u] = await sql`insert into app_users (email, display_name, role) values (${`online-${name}-${stamp}@example.test`}, 'Real Name', 'user') returning id`;
  users.push(u.id);
  await ensureStarter(sql, u.id);
  return u.id;
};
const points = async id => Number((await sql`select points from player_ranks where user_id = ${id}`)[0].points);
const setPoints = (id, p) => sql`update player_ranks set points = ${p}, best_league = 2 where user_id = ${id}`;

try {
  const a = await newUser("a"), b = await newUser("b"), c = await newUser("c");
  for (const id of [a, b, c]) { await loadRank(sql, id, cfg); await setPoints(id, 300); }

  // ---- a normal game: the winner's claim waits for the loser, then counts in full (online: no computer halving)
  let key = `on-${stamp}-1`;
  check("a computer key cannot start online, nor an online key against the computer",
    await code(startMatch(sql, a, cfg, `rk-${stamp}-x`, "online")) === "bad_match_key" && await code(startMatch(sql, a, cfg, key, "ai")) === "bad_match_key");
  await startMatch(sql, a, cfg, key, "online");
  await startMatch(sql, b, cfg, key, "online");
  check("a third player cannot join a started online game", await code(startMatch(sql, c, cfg, key, "online")) === "match_full");
  let ra = await reportMatch(sql, a, cfg, { matchKey: key, result: "win", turns: 9 });
  check("the winner reports first: pending, no points yet", ra.outcome.pending === true && await points(a) === 300);
  let rb = await reportMatch(sql, b, cfg, { matchKey: key, result: "lose", turns: 9 });
  check("the loser's report counts at once (-20)", rb.outcome.delta === -20 && await points(b) === 280);
  ra = await reportMatch(sql, a, cfg, { matchKey: key, result: "win", turns: 9 });
  check("asking again: the win is confirmed (+30)", ra.outcome.delta === 30 && !ra.outcome.pending && await points(a) === 330);
  ra = await reportMatch(sql, a, cfg, { matchKey: key, result: "win", turns: 9 });
  check("and only once", ra.outcome.already && await points(a) === 330);

  // ---- the loser reports first: the winner's report counts at once
  key = `on-${stamp}-2`;
  await startMatch(sql, a, cfg, key, "online");
  await startMatch(sql, b, cfg, key, "online");
  await reportMatch(sql, b, cfg, { matchKey: key, result: "lose", turns: 7 });
  ra = await reportMatch(sql, a, cfg, { matchKey: key, result: "win", turns: 7 });
  check("loser first, then the win counts immediately", ra.outcome.delta === 30 && await points(a) === 360);

  // ---- both claim the win: disputed, nobody moves
  key = `on-${stamp}-3`;
  await startMatch(sql, a, cfg, key, "online");
  await startMatch(sql, b, cfg, key, "online");
  const pa = await points(a), pb = await points(b);
  await reportMatch(sql, a, cfg, { matchKey: key, result: "win", turns: 8 });
  rb = await reportMatch(sql, b, cfg, { matchKey: key, result: "win", turns: 8 });
  ra = await reportMatch(sql, a, cfg, { matchKey: key, result: "win", turns: 8 });
  check("both claim the win: disputed, no points for anyone", rb.outcome.result === "disputed" && ra.outcome.result === "disputed" && await points(a) === pa && await points(b) === pb);

  // ---- the opponent leaves and never reports: the win counts after the waiting time, their game is a loss
  key = `on-${stamp}-4`;
  await startMatch(sql, a, cfg, key, "online");
  await startMatch(sql, b, cfg, key, "online");
  ra = await reportMatch(sql, a, cfg, { matchKey: key, result: "win", turns: 10 });
  check("a silent opponent: pending at first", ra.outcome.pending === true);
  await sql`update ranked_matches set claimed_at = now() - interval '10 minutes' where user_id = ${a} and match_key = ${key}`;
  const pb2 = await points(b);
  const pa4 = await points(a);
  const loaded = await loadRank(sql, a, cfg);
  // the third win in a row: +30 and the streak bonus +10
  check("after the waiting time the next visit confirms the win (+40 with the streak)", loaded.confirmed.length === 1 && loaded.confirmed[0].delta === 40 && await points(a) === pa4 + 40);
  check("... and shows it in the status", (await publicStatus(sql, a, cfg, loaded)).confirmed[0].delta === 40);
  check("the silent opponent's game became a loss (-20)", await points(b) === pb2 - 20);
  rb = await reportMatch(sql, b, cfg, { matchKey: key, result: "lose", turns: 10 });
  check("their late report changes nothing", rb.outcome.already && await points(b) === pb2 - 20);

  // ---- a pending online claim survives starting another game; a game nobody joined is void
  key = `on-${stamp}-5`;
  await startMatch(sql, c, cfg, key, "online");
  await reportMatch(sql, c, cfg, { matchKey: key, result: "win", turns: 9 });
  const r2 = await startMatch(sql, c, cfg, `rk-${stamp}-c1`);
  check("starting another game does not count a pending online win as lost", r2.settled.length === 0);
  await sql`update ranked_matches set claimed_at = now() - interval '10 minutes' where user_id = ${c} and match_key = ${key}`;
  const pc = await points(c);
  const rc = await reportMatch(sql, c, cfg, { matchKey: key, result: "win", turns: 9 });
  check("no opponent ever joined: void, no points", rc.outcome.result === "void" || rc.outcome.already);
  check("... nothing moved", await points(c) === pc);

  // ---- statistics: both phones log the game under one key, which pairs the opponents
  await setNickname(sql, a, "Alpha Tester");
  await setNickname(sql, b, "Beta Tester");
  check("a chosen nickname is marked as chosen", (await publicStatus(sql, a, cfg, await loadRank(sql, a, cfg))).nicknameChosen === true);
  const shared = `on-${stamp}-stats`;
  await rewardMatch(sql, a, { mode: "online", result: "win", turns: 12, matchKey: shared, kind: "casual", opponentName: "Beta Tester" });
  await rewardMatch(sql, b, { mode: "online", result: "lose", turns: 12, matchKey: shared, kind: "casual", opponentName: "Alpha Tester" });
  const conceded = await rewardMatch(sql, a, { mode: "ai", result: "lose", turns: 3, matchKey: `ai-${stamp}-c`, kind: "practice", aiLevel: 2, noReward: true });
  check("a conceded game is logged without coins", conceded.coins === 0 && conceded.reason === "none");
  const friend = await rewardMatch(sql, a, { mode: "online", result: "draw", turns: 15, matchKey: `on-${stamp}-friend`, kind: "friend" });
  check("a game against a friend pays nothing", friend.coins === 0);
  const stats = await myStats(sql, cfg, a);
  const last = stats.recent.find(g => g.kind === "casual");
  check("recent games: the online opponent's nickname and account", last?.opponent?.name === "Beta Tester" && last.opponent.id === b);
  check("recent games: the computer game keeps its level", stats.recent.some(g => g.mode === "ai" && g.aiLevel === 2));
  check("totals: by kind and mode, draws counted", stats.totals.byKind.casual.wins === 1 && stats.totals.byKind.friend.draws === 1 && stats.totals.all.games === 3 && stats.totals.online.games === 2);
  check("collection: owned out of the catalog, by kind and rarity", stats.collection.owned > 0 && stats.collection.total >= stats.collection.owned && stats.collection.byKind.monster.total > 0);
  check("rank in the statistics", stats.rank.points === await points(a) && stats.rank.place >= 1);
  const prof = await publicProfile(sql, cfg, b);
  check("a public profile: nickname, rank and record, never the sign-in name", prof.nickname === "Beta Tester" && prof.totals.online.games === 1 && !JSON.stringify(prof).includes("Real Name") && !JSON.stringify(prof).includes("@example"));
  check("a bad profile id is refused", await code(publicProfile(sql, cfg, "nope")) === "bad_user");
  const board = await leaderboard(sql, cfg, a);
  check("the leaderboard rows carry the player's id (to open a profile)", board.top.some(r => r.id === a && r.me));
} finally {
  for (const id of users) await sql`delete from app_users where id = ${id}`;
}

console.log(failed ? `\n${failed} FAILED` : "\nall online checks passed");
process.exit(failed ? 1 : 0);
