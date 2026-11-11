// Checks ranked play (points, floors, streaks, mercy, seasons, rewards, nicknames) against a test database branch.
//   DATABASE_URL=<test branch> node scripts/ranks-test.mjs
import { neon } from "@neondatabase/serverless";
import { ensureStarter, loadState } from "../netlify/functions/_lib/economy.mjs";
import {
  DEFAULT_RANKS, adminAdjust, aiLevelFor, checkLeagueStarts, checkNickname, distribution, leaderboard, leagueOf, loadRank, normalizeRanks,
  publicStatus, reportMatch, scoreMatch, seasonAt, seasonResetPoints, setNickname, startMatch, israelMonthStart
} from "../netlify/functions/_lib/ranks.mjs";

const sql = neon(process.env.DATABASE_URL);
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const code = fn => { try { fn(); return null; } catch (e) { return e.publicCode || e.message; } };
const cfg = normalizeRanks(null);

// ---- pure rules
check("10 leagues, Arcadia to Heaven Gardens", cfg.leagues.length === 10 && cfg.leagues[0].en === "Arcadia" && cfg.leagues[9].en === "Heaven Gardens");
check("league of 0 / 199 / 200 / 4999", leagueOf(cfg, 0).league === 1 && leagueOf(cfg, 199).league === 1 && leagueOf(cfg, 200).league === 2 && leagueOf(cfg, 4999).league === 10);
const s = (points, streak = 0) => ({ points, streak });
check("win +30", scoreMatch(cfg, s(100), { result: "win", turns: 9 }).delta === 30);
check("league 1 loses nothing", scoreMatch(cfg, s(100), { result: "lose" }).delta === 0);
check("league 2 floor: 210 - 20 stops at 200", scoreMatch(cfg, s(210), { result: "lose" }).points === 200);
check("league 4 has no floor: 760 - 20 = 740", scoreMatch(cfg, s(760), { result: "lose" }).points === 740);
check("league 6 loses 30", scoreMatch(cfg, s(1600), { result: "lose" }).delta === -30);
check("league 7+ vs the computer: half (+15 / -15)", scoreMatch(cfg, s(2000), { result: "win", turns: 9, mode: "ai" }).delta === 15 && scoreMatch(cfg, s(2000), { result: "lose", mode: "ai" }).delta === -15);
check("league 7+ online: full", scoreMatch(cfg, s(2000), { result: "win", turns: 9, mode: "online" }).delta === 30);
check("3rd win in a row: +10 bonus", scoreMatch(cfg, s(100, 2), { result: "win", turns: 9 }).delta === 40 && scoreMatch(cfg, s(100, 1), { result: "win", turns: 9 }).delta === 30);
check("no streak bonus from league 7", scoreMatch(cfg, s(2000, 5), { result: "win", turns: 9 }).delta === 15);
check("a short win earns nothing and keeps the streak", (r => r.delta === 0 && !r.counted && r.streak === 2)(scoreMatch(cfg, s(100, 2), { result: "win", turns: 3 })));
check("a loss breaks a win streak", scoreMatch(cfg, s(300, 4), { result: "lose" }).streak === -1);
check("draw: no points, streak reset", (r => r.delta === 0 && r.streak === 0)(scoreMatch(cfg, s(300, 4), { result: "draw" })));
check("cap 5000", scoreMatch(cfg, s(4990), { result: "win", turns: 9, mode: "online" }).points === 5000);
check("the computer plays the league's level", aiLevelFor(cfg, s(800)) === 4);
check("mercy: 3 losses in a row, one level lower", aiLevelFor(cfg, s(800, -3)) === 3 && aiLevelFor(cfg, s(0, -5)) === 1);
const bad = normalizeRanks({ leagues: [{ league: 2, min: 50 }, { league: 3, min: 10 }], cap: 1 });
check("config: starts always grow, cap above the last", bad.leagues[2].min === 51 && bad.cap > bad.leagues[9].min);
check("config: bundles cleaned", JSON.stringify(normalizeRanks({ leagues: [{ league: 2, reward: { coins: "70", packs: { premium: 99, nope: 3 } } }] }).leagues[1].reward) === '{"coins":70,"packs":{"premium":10}}');
const throws = f => { try { f(); return false; } catch (e) { return e.statusCode === 400; } };
const starts = mins => ({ leagues: DEFAULT_RANKS.leagues.map((l, i) => ({ league: l.league, min: mins[i] })) });
check("save: the default starts pass", !throws(() => checkLeagueStarts(DEFAULT_RANKS)));
check("save: an emptied league-2 start is refused", throws(() => checkLeagueStarts(starts([0, "", 450, 750, 1100, 1500, 1950, 2450, 3000, 3600]))));
check("save: league 2 at 0 or 1 below league 1 is refused", throws(() => checkLeagueStarts(starts([0, 0, 450, 750, 1100, 1500, 1950, 2450, 3000, 3600]))));
check("save: starts that do not grow are refused", throws(() => checkLeagueStarts(starts([0, 200, 450, 450, 1100, 1500, 1950, 2450, 3000, 3600]))));

// ---- seasons
const at = iso => seasonAt(cfg, Date.parse(iso));
check("now (2026) is the pre-season, ending 1.1.2027 00:00 Israel", (x => x.pre && x.number === 0 && x.endsAt === "2026-12-31T22:00:00.000Z")(at("2026-11-10T12:00:00Z")));
check("31.12.2026 23:30 Israel is still the pre-season", at("2026-12-31T21:30:00Z").pre);
check("1.1.2027 00:30 Israel is season 1 (2027-01)", (x => x.id === "2027-01" && x.number === 1)(at("2026-12-31T22:30:00Z")));
check("season 1 ends 1.4.2027 00:00 Israel (summer time)", at("2027-02-10T00:00:00Z").endsAt === "2027-03-31T21:00:00.000Z");
check("May 2027 is season 2 (2027-04)", (x => x.id === "2027-04" && x.number === 2)(at("2027-05-20T00:00:00Z")));
check("January 2028 is season 5", at("2028-01-15T00:00:00Z").number === 5);
check("Israel midnight 1.7.2027 = 21:00 UTC", israelMonthStart(2027, 7).toISOString() === "2027-06-30T21:00:00.000Z");
check("first season starts everyone from 0", seasonResetPoints(cfg, 2400, "pre-2027", at("2027-01-05T00:00:00Z")) === 0);
check("later seasons: points above 750 are halved", seasonResetPoints(cfg, 2000, "2027-01", at("2027-05-01T00:00:00Z")) === 1375 && seasonResetPoints(cfg, 600, "2027-01", at("2027-05-01T00:00:00Z")) === 600);

// ---- nicknames
check("nickname ok", checkNickname("  Dragon  Slayer ") === "Dragon Slayer" && checkNickname("גנן_7") === "גנן_7");
check("nickname too short / long", code(() => checkNickname("ab")) === "nickname_length" && code(() => checkNickname("x".repeat(17))) === "nickname_length");
check("nickname bad characters (no #)", code(() => checkNickname("Gardener#12")) === "nickname_chars" && code(() => checkNickname("...")) === "nickname_chars");
check("nickname bad words", code(() => checkNickname("Fuck3r")) === "nickname_banned" && code(() => checkNickname("sh1t head")) === "nickname_banned" && code(() => checkNickname("בן זונה")) === "nickname_banned");
check("nickname: innocent words with short banned parts pass", checkNickname("Classic Asset") === "Classic Asset");

// ---- with the database: a throwaway player
const [user] = await sql`insert into app_users (email, display_name, role) values (${"ranks-" + Date.now() + "@example.test"}, 'Real Name', 'user') returning id`;
const uid = user.id;
const stamp = Date.now();
const key = n => `rk-${stamp}-${n}`;
try {
  await ensureStarter(sql, uid);
  let loaded = await loadRank(sql, uid, cfg);
  check("first look: 0 points, league 1, a generated nickname", loaded.row.points === 0 && /^Gardener#\d+$/.test((await publicStatus(sql, uid, cfg, loaded)).nickname));

  let r = await startMatch(sql, uid, cfg, key(1));
  check("start: the computer plays level 1", r.aiLevel === 1);
  let rep = await reportMatch(sql, uid, cfg, { matchKey: key(1), result: "win", turns: 10 });
  check("report win: +30", rep.outcome.delta === 30 && rep.row.points === 30);
  rep = await reportMatch(sql, uid, cfg, { matchKey: key(1), result: "win", turns: 10 });
  check("reporting again changes nothing", rep.outcome.already && rep.row.points === 30);
  check("an unknown match is refused", await reportMatch(sql, uid, cfg, { matchKey: key(99), result: "win", turns: 10 }).then(() => null, e => e.publicCode) === "unknown_match");

  // a match left open counts as a loss when the next one starts
  await adminAdjust(sql, cfg, null, { userId: uid, points: 300, note: "test" });
  await startMatch(sql, uid, cfg, key(2));
  r = await startMatch(sql, uid, cfg, key(3));
  check("an open match counts as a loss when the next starts (300 - 20)", r.settled.length === 1 && r.settled[0].result === "abandoned" && r.row.points === 280);
  check("finishing the abandoned match later changes nothing", (await reportMatch(sql, uid, cfg, { matchKey: key(2), result: "win", turns: 10 })).outcome.already);
  // ... or after 2 hours
  await sql`update ranked_matches set started_at = now() - interval '3 hours' where user_id = ${uid} and match_key = ${key(3)}`;
  loaded = await loadRank(sql, uid, cfg);
  check("an open match older than 2 hours counts as a loss", loaded.settled.length === 1 && loaded.row.points === 260);
  check("concede = lose", (await (async () => { await startMatch(sql, uid, cfg, key(4)); return reportMatch(sql, uid, cfg, { matchKey: key(4), result: "lose", turns: 2 }); })()).outcome.delta === -20);

  // mercy after 3 losses in a row
  r = await startMatch(sql, uid, cfg, key(5));
  check("after 3 losses in a row the computer drops a level (league 2 -> level 1)", r.aiLevel === 1);
  await reportMatch(sql, uid, cfg, { matchKey: key(5), result: "win", turns: 8 });

  // league-up rewards, once per season
  const before = await loadState(sql, uid);
  await adminAdjust(sql, cfg, null, { userId: uid, points: 1090, note: "test" });
  await sql`update player_ranks set best_league = 3 where user_id = ${uid}`; // as if leagues 4–5 were not reached yet
  await startMatch(sql, uid, cfg, key(6));
  rep = await reportMatch(sql, uid, cfg, { matchKey: key(6), result: "win", turns: 9 });
  const after = await loadState(sql, uid);
  check("reaching Shangri-La pays leagues 4 and 5 (a basic pack, 10 apples)", rep.outcome.promoted && rep.outcome.rewards.map(x => x.league).join() === "4,5" && after.apples === before.apples + 10);
  check("the pack's cards were added", Object.values(after.cards).reduce((a, c) => a + c.count, 0) + Object.values(after.shards).reduce((a, b) => a + b, 0) > Object.values(before.cards).reduce((a, c) => a + c.count, 0) + Object.values(before.shards).reduce((a, b) => a + b, 0));
  await sql`update player_ranks set best_league = 4 where user_id = ${uid}`;
  await startMatch(sql, uid, cfg, key(7));
  rep = await reportMatch(sql, uid, cfg, { matchKey: key(7), result: "win", turns: 9 });
  check("a league's reward is paid once per season", rep.outcome.rewards.length === 0);

  // nickname
  await setNickname(sql, uid, "Test Ranker " + (Date.now() % 1000));
  const [other] = await sql`insert into app_users (email, display_name, role, nickname) values (${"ranks2-" + stamp + "@example.test"}, 'Other', 'user', ${"Taken" + stamp % 100000}) returning id`;
  check("a taken nickname is refused (any letter case)", await setNickname(sql, uid, ("taken" + stamp % 100000).toUpperCase()).then(() => null, e => e.publicCode) === "nickname_taken");
  await sql`delete from app_users where id = ${other.id}`;
  const board = await leaderboard(sql, cfg, uid);
  check("the leaderboard shows the nickname, never the real name", board.top.some(t => t.me && t.nickname.startsWith("Test Ranker")) && !board.top.some(t => t.nickname === "Real Name") && board.mine?.place >= 1);
  check("distribution counts the player", (await distribution(sql, cfg)).players >= 1);

  // a new season: the first real one starts from 0 and pays the pre-season reward
  const ptsBefore = (await loadRank(sql, uid, cfg)).row.points;
  const wallet0 = await loadState(sql, uid);
  loaded = await loadRank(sql, uid, cfg, Date.parse("2027-01-10T12:00:00Z"));
  check(`season 1 starts from 0 (was ${ptsBefore})`, loaded.row.points === 0 && loaded.row.season === "2027-01");
  check("the pre-season reward is paid by the best league (Shangri-La: 750 coins)", loaded.seasonReward?.coins === 750 && (await loadState(sql, uid)).coins === wallet0.coins + 750);
  await sql`update player_ranks set points = 2000, best_league = 7 where user_id = ${uid}`;
  loaded = await loadRank(sql, uid, cfg, Date.parse("2027-04-10T12:00:00Z"));
  check("season 2 halves the points above 750 (2000 -> 1375) and pays Valhalla's reward", loaded.row.points === 1375 && loaded.seasonReward?.packs?.length === 1);
  loaded = await loadRank(sql, uid, cfg, Date.parse("2027-04-11T12:00:00Z"));
  check("the season reward is paid once", loaded.seasonReward === null);
} finally {
  await sql`delete from app_users where id = ${uid}`;
}

console.log(failed ? `\n${failed} FAILED` : "\nall ranked checks passed");
process.exit(failed ? 1 : 0);
