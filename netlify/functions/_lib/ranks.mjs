import crypto from "node:crypto";
import { grantBundle, httpError } from "./economy.mjs";

// Ranked play: 10 leagues by points, seasons with a reset, ranked matches against the computer (a started match with no
// result becomes a loss), one-time league rewards and season rewards, and public nicknames for the leaderboard.
// Every number lives in app_settings 'ranks' (edited in the back office); DEFAULT_RANKS is used for anything missing.

const TZ = "Asia/Jerusalem";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PACK_IDS = ["basic", "big", "premium"];

const L = (league, min, he, en, loss, extra = {}) => ({
  league, min, he, en, win: 30, loss, floor: false, streak: league <= 6, aiPercent: league >= 7 ? 50 : 100, aiLevel: league,
  reward: {}, seasonReward: {}, ...extra
});

export const DEFAULT_RANKS = {
  cap: 5000,
  streakFrom: 3,          // the 3rd win in a row and on earns the bonus
  streakBonus: 10,
  mercyAfter: 3,          // after this many losses in a row the computer plays one level lower, until a win
  minTurns: 6,            // a shorter win earns no points (a loss always counts)
  openMinutes: 120,       // a started match with no result after this long is a loss
  seasonMonths: 3,
  firstSeasonStart: "2027-01-01", // before it: the pre-season; everyone starts the first season from 0
  resetFrom: 750,         // at a season's end the points above this are cut...
  resetKeepPercent: 50,   // ...to this share
  leagues: [
    L(1, 0, "ארקדיה", "Arcadia", 0, { floor: true, seasonReward: { coins: 100 } }),
    L(2, 200, "אטלנטיס", "Atlantis", 20, { floor: true, reward: { coins: 500 }, seasonReward: { coins: 200 } }),
    L(3, 450, "אל דוראדו", "El Dorado", 20, { floor: true, reward: { coins: 1000 }, seasonReward: { coins: 300 } }),
    L(4, 750, "אבלון", "Avalon", 20, { reward: { packs: { basic: 1 } }, seasonReward: { coins: 500 } }),
    L(5, 1100, "שנגרי-לה", "Shangri-La", 20, { reward: { apples: 10 }, seasonReward: { coins: 750 } }),
    L(6, 1500, "אסגארד", "Asgard", 30, { reward: { packs: { big: 1 } }, seasonReward: { coins: 1000 } }),
    L(7, 1950, "ולהאלה", "Valhalla", 30, { reward: { apples: 25 }, seasonReward: { packs: { basic: 1 } } }),
    L(8, 2450, "אליסיום", "Elysium", 30, { reward: { packs: { premium: 1 } }, seasonReward: { packs: { big: 1 } } }),
    L(9, 3000, "אולימפוס", "Olympus", 30, { reward: { apples: 50 }, seasonReward: { apples: 25 } }),
    L(10, 3600, "הגנים השמימיים", "Heaven Gardens", 30, { reward: { packs: { premium: 2 } }, seasonReward: { packs: { premium: 1 } } })
  ]
};

const int = (v, min, max, fallback) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const text = (v, fallback, max = 40) => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || fallback;
};

export function normalizeBundle(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const out = {};
  const coins = int(b.coins, 0, 1_000_000, 0), apples = int(b.apples, 0, 100_000, 0);
  if (coins) out.coins = coins;
  if (apples) out.apples = apples;
  const packs = {};
  for (const id of PACK_IDS) { const n = int(b.packs?.[id], 0, 10, 0); if (n) packs[id] = n; }
  if (Object.keys(packs).length) out.packs = packs;
  return out;
}

const bundleEmpty = b => !b.coins && !b.apples && !b.packs;

/** Cleans a config from the back office (or the database): every field present, sane ranges, growing league starts. */
export function normalizeRanks(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_RANKS;
  const cfg = {
    cap: int(r.cap, 100, 1_000_000, d.cap),
    streakFrom: int(r.streakFrom, 2, 20, d.streakFrom),
    streakBonus: int(r.streakBonus, 0, 1000, d.streakBonus),
    mercyAfter: int(r.mercyAfter, 0, 20, d.mercyAfter),
    minTurns: int(r.minTurns, 0, 100, d.minTurns),
    openMinutes: int(r.openMinutes, 10, 7 * 24 * 60, d.openMinutes),
    seasonMonths: int(r.seasonMonths, 1, 12, d.seasonMonths),
    firstSeasonStart: /^\d{4}-\d{2}-01$/.test(String(r.firstSeasonStart)) ? r.firstSeasonStart : d.firstSeasonStart,
    resetFrom: int(r.resetFrom, 0, 1_000_000, d.resetFrom),
    resetKeepPercent: int(r.resetKeepPercent, 0, 100, d.resetKeepPercent),
    leagues: []
  };
  const given = Array.isArray(r.leagues) ? r.leagues : [];
  let previous = -1;
  for (const def of d.leagues) {
    const g = given.find(x => Number(x?.league) === def.league) || {};
    let min = def.league === 1 ? 0 : int(g.min, 1, 1_000_000, def.min);
    if (min <= previous) min = previous + 1; // starts always grow
    previous = min;
    cfg.leagues.push({
      league: def.league,
      min,
      he: text(g.he, def.he),
      en: text(g.en, def.en),
      win: int(g.win, 0, 1000, def.win),
      loss: int(g.loss, 0, 1000, def.loss),
      floor: typeof g.floor === "boolean" ? g.floor : def.floor,
      streak: typeof g.streak === "boolean" ? g.streak : def.streak,
      aiPercent: int(g.aiPercent, 0, 100, def.aiPercent),
      aiLevel: int(g.aiLevel, 1, 10, def.aiLevel),
      reward: normalizeBundle(g.reward ?? def.reward),
      seasonReward: normalizeBundle(g.seasonReward ?? def.seasonReward)
    });
  }
  if (cfg.cap <= previous) cfg.cap = previous + 1;
  return cfg;
}

export async function loadRanks(sql) {
  try {
    const [row] = await sql`select value from app_settings where key = 'ranks'`;
    return normalizeRanks(row?.value);
  } catch { return normalizeRanks(null); }
}

/**
 * A save must state every league's start, growing from league 2 (above 0). Loading still repairs a bad stored
 * config, but a save never repairs silently: an emptied field once became "league 2 starts at 1".
 */
export function checkLeagueStarts(raw) {
  const given = Array.isArray(raw?.leagues) ? raw.leagues : [];
  let previous = 0;
  for (const def of DEFAULT_RANKS.leagues) {
    if (def.league === 1) continue;
    const g = given.find(x => Number(x?.league) === def.league);
    const v = g?.min;
    const n = v === "" || v === null || v === undefined ? NaN : Number(v);
    if (!Number.isInteger(n) || n <= previous)
      throw httpError(400, "bad_league_start", `league ${def.league} must start above ${previous} points`);
    previous = n;
  }
}

export async function saveRanks(sql, raw, adminId) {
  checkLeagueStarts(raw);
  const cfg = normalizeRanks(raw);
  await sql`
    insert into app_settings (key, value, updated_at, updated_by)
    values ('ranks', ${JSON.stringify(cfg)}::jsonb, now(), ${adminId})
    on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
  `;
  return cfg;
}

export const leagueOf = (cfg, points) => [...cfg.leagues].reverse().find(l => points >= l.min) || cfg.leagues[0];

// ---------------------------------------------------------------- seasons (midnight, Israel time)

function israelDate(ms) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms)).split("-").map(Number);
  return { y, m, d };
}

function offsetMinutes(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms) / 60000);
}

/** The moment it is midnight in Israel at the start of that month (month 1–12, may overflow). */
export function israelMonthStart(y, m) {
  const base = Date.UTC(y, m - 1, 1);
  let t = base - offsetMinutes(base) * 60000;
  t = base - offsetMinutes(t) * 60000; // the offset at the real instant (DST)
  return new Date(t);
}

/**
 * The season at a moment: { id, number, pre, startsAt, endsAt }. Before firstSeasonStart it is the pre-season
 * (number 0); then seasons of seasonMonths months, id "YYYY-MM" of their first month.
 */
export function seasonAt(cfg, ms = Date.now()) {
  const [y0, m0] = cfg.firstSeasonStart.split("-").map(Number);
  const first = israelMonthStart(y0, m0);
  if (ms < first.getTime()) return { id: `pre-${y0}`, number: 0, pre: true, startsAt: null, endsAt: first.toISOString() };
  const { y, m } = israelDate(ms);
  const months = (y - y0) * 12 + (m - m0);
  const index = Math.floor(months / cfg.seasonMonths);
  const startMonths = m0 - 1 + index * cfg.seasonMonths;
  const sy = y0 + Math.floor(startMonths / 12), sm = (startMonths % 12) + 1;
  const start = israelMonthStart(sy, sm), end = israelMonthStart(sy, sm + cfg.seasonMonths);
  return { id: `${sy}-${String(sm).padStart(2, "0")}`, number: index + 1, pre: false, startsAt: start.toISOString(), endsAt: end.toISOString() };
}

/** Points carried into a new season: the first real season starts from 0, later ones cut the points above resetFrom. */
export function seasonResetPoints(cfg, points, fromSeasonId, toSeason) {
  if (String(fromSeasonId).startsWith("pre-") && !toSeason.pre) return 0;
  if (points <= cfg.resetFrom) return points;
  return cfg.resetFrom + Math.floor((points - cfg.resetFrom) * cfg.resetKeepPercent / 100);
}

// ---------------------------------------------------------------- points

/**
 * The points after one ranked game. state = { points, streak }, game = { result: win|lose|draw, turns, mode }.
 * Returns { points, delta, streak, counted }.
 */
export function scoreMatch(cfg, state, game) {
  const league = leagueOf(cfg, state.points);
  const factor = game.mode === "online" ? 1 : league.aiPercent / 100;
  let gain = 0, streak = state.streak;
  if (game.result === "win") {
    if ((game.turns || 0) < cfg.minTurns) return { points: state.points, delta: 0, streak, counted: false };
    streak = streak > 0 ? streak + 1 : 1;
    gain = Math.round((league.win + (league.streak && streak >= cfg.streakFrom ? cfg.streakBonus : 0)) * factor);
  } else if (game.result === "draw") {
    streak = 0;
  } else {
    streak = streak < 0 ? streak - 1 : -1;
    gain = -Math.round(league.loss * factor);
  }
  let points = Math.max(0, Math.min(cfg.cap, state.points + gain));
  if (gain < 0 && league.floor) points = Math.max(points, Math.min(state.points, league.min));
  return { points, delta: points - state.points, streak, counted: true };
}

/** The computer's level for a ranked game: the league's, one lower after mercyAfter losses in a row. */
export function aiLevelFor(cfg, row) {
  const league = leagueOf(cfg, row.points);
  const mercy = cfg.mercyAfter > 0 && row.streak <= -cfg.mercyAfter ? 1 : 0;
  return Math.max(1, league.aiLevel - mercy);
}

// ---------------------------------------------------------------- nicknames

const BANNED_PARTS = ["fuck", "shit", "bitch", "cunt", "nigg", "faggot", "whore", "slut", "pussy", "rapist", "hitler", "nazi",
  "admin", "moderator", "heavengardens", "imrigames", "זונה", "שרמוט", "מניאק", "היטלר", "נאצי", "קוקסינל"];
const BANNED_WORDS = ["ass", "dick", "cock", "fag", "rape", "sex", "כוס", "זין", "חרא", "הומו", "לסבית", "מנוול"];

/** Checks a chosen nickname: 3–16 letters (any language), digits, spaces, "_", "-" or "."; nothing offensive. */
export function checkNickname(raw) {
  const name = String(raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length < 3 || name.length > 16) throw httpError(400, "nickname_length");
  if (!/^[\p{L}\p{M}\d _.\-]+$/u.test(name) || !/[\p{L}\d]/u.test(name)) throw httpError(400, "nickname_chars");
  const lower = name.toLowerCase();
  const compact = lower.replace(/[^\p{L}\d]/gu, "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s");
  const words = lower.split(/[^\p{L}\d]+/u).filter(Boolean);
  if (BANNED_PARTS.some(b => compact.includes(b)) || words.some(w => BANNED_WORDS.includes(w))) throw httpError(400, "nickname_banned");
  return name;
}

/** The player's nickname, generating "Gardener#1234" the first time. */
export async function ensureNickname(sql, userId) {
  const [row] = await sql`select nickname from app_users where id = ${userId}`;
  if (row?.nickname) return row.nickname;
  for (let i = 0; i < 8; i++) {
    const name = `Gardener#${crypto.randomInt(1000, i < 4 ? 10000 : 100000)}`;
    try {
      const done = await sql`update app_users set nickname = ${name} where id = ${userId} and nickname is null returning nickname`;
      if (done.length) return done[0].nickname;
      const [again] = await sql`select nickname from app_users where id = ${userId}`;
      if (again?.nickname) return again.nickname;
    } catch { /* taken: try another number */ }
  }
  throw httpError(500, "nickname_failed");
}

export async function setNickname(sql, userId, raw) {
  const name = checkNickname(raw);
  try {
    await sql`update app_users set nickname = ${name} where id = ${userId}`;
  } catch {
    throw httpError(409, "nickname_taken");
  }
  return name;
}

// ---------------------------------------------------------------- the player's rank

const numRow = r => r && ({ ...r, points: Number(r.points), best_league: Number(r.best_league), streak: Number(r.streak), games: Number(r.games), wins: Number(r.wins) });

/**
 * Loads the player's rank for the current season, creating it on first use, carrying it into a new season (paying the
 * last season's reward) and settling matches that never reported (losses). Returns { row, season, seasonReward, settled }.
 */
export async function loadRank(sql, userId, cfg, now = Date.now()) {
  const season = seasonAt(cfg, now);
  let [row] = await sql`select * from player_ranks where user_id = ${userId}`;
  if (!row) {
    await ensureNickname(sql, userId);
    await sql`insert into player_ranks (user_id, season) values (${userId}, ${season.id}) on conflict (user_id) do nothing`;
    [row] = await sql`select * from player_ranks where user_id = ${userId}`;
  }
  row = numRow(row);
  let seasonReward = null;
  if (row.season !== season.id) {
    const old = row.season, oldBest = row.best_league;
    const points = seasonResetPoints(cfg, row.points, old, season);
    const best = leagueOf(cfg, points).league;
    const moved = await sql`
      update player_ranks set season = ${season.id}, points = ${points}, best_league = ${best}, streak = 0, updated_at = now()
      where user_id = ${userId} and season = ${old}
      returning *
    `;
    if (moved.length) {
      await sql`insert into rank_events (user_id, kind, detail) values (${userId}, 'season_reset',
        ${JSON.stringify({ from: old, to: season.id, before: row.points, after: points })}::jsonb)`;
      // matches still open from the old season simply close (no points move across seasons)
      await sql`update ranked_matches set finished_at = now(), result = 'abandoned', delta = 0
        where user_id = ${userId} and finished_at is null and season = ${old}`;
      const league = cfg.leagues.find(l => l.league === oldBest) || cfg.leagues[0];
      if (!bundleEmpty(league.seasonReward)) {
        const paid = await grantBundle(sql, userId, `${old}:season`, league.seasonReward, "season_reward");
        if (paid) seasonReward = { season: old, league: oldBest, ...paid };
      }
      row = numRow(moved[0]);
    } else {
      row = numRow((await sql`select * from player_ranks where user_id = ${userId}`)[0]);
    }
  }
  const settled = [];
  const expired = await sql`
    select match_key from ranked_matches
    where user_id = ${userId} and finished_at is null and started_at < now() - make_interval(mins => ${cfg.openMinutes})
    order by started_at
  `;
  for (const m of expired) {
    const r = await finishMatch(sql, userId, cfg, row, m.match_key, "abandoned", 0, season);
    if (r) { row = r.row; settled.push(r.outcome); }
  }
  return { row, season, seasonReward, settled };
}

/**
 * Records one match's result and moves the points (once: a finished match is never scored again). "abandoned" scores
 * as a loss. Pays the rewards of every league newly reached this season. Returns { row, outcome } or null.
 */
async function finishMatch(sql, userId, cfg, row, matchKey, result, turns, season) {
  const score = scoreMatch(cfg, row, { result: result === "abandoned" ? "lose" : result, turns, mode: "ai" });
  const league = leagueOf(cfg, score.points).league;
  const won = result === "win" && score.counted ? 1 : 0;
  const rows = await sql`
    with m as (
      update ranked_matches set finished_at = now(), result = ${result}, turns = ${turns},
        points_before = ${row.points}, points_after = ${score.points}, delta = ${score.delta}
      where user_id = ${userId} and match_key = ${matchKey} and finished_at is null
      returning 1
    )
    update player_ranks set points = ${score.points}, streak = ${score.streak},
      best_league = greatest(best_league, ${league}),
      reached_at = case when ${score.delta} > 0 then now() else reached_at end,
      games = games + 1, wins = wins + ${won}, updated_at = now()
    where user_id = ${userId} and exists (select 1 from m)
    returning *
  `;
  if (!rows.length) return null;
  const next = numRow(rows[0]);
  const rewards = [];
  for (let n = row.best_league + 1; n <= league; n++) {
    const l = cfg.leagues.find(x => x.league === n);
    if (!l || bundleEmpty(l.reward)) continue;
    const paid = await grantBundle(sql, userId, `${season.id}:league:${n}`, l.reward, "league_reward");
    if (paid) rewards.push({ league: n, ...paid });
  }
  const before = leagueOf(cfg, row.points).league;
  return {
    row: next,
    outcome: { matchKey, result, delta: score.delta, counted: score.counted, points: score.points, league, leagueBefore: before, promoted: league > before, rewards }
  };
}

/** Starts a ranked match against the computer: an older unfinished one counts as a loss first. */
export async function startMatch(sql, userId, cfg, matchKey) {
  const key = String(matchKey || "").slice(0, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw httpError(400, "bad_match_key");
  let { row, season, seasonReward, settled } = await loadRank(sql, userId, cfg);
  const open = await sql`select match_key from ranked_matches where user_id = ${userId} and finished_at is null and match_key <> ${key} order by started_at`;
  for (const m of open) {
    const r = await finishMatch(sql, userId, cfg, row, m.match_key, "abandoned", 0, season);
    if (r) { row = r.row; settled.push(r.outcome); }
  }
  await sql`
    insert into ranked_matches (user_id, match_key, mode, season, ai_level)
    values (${userId}, ${key}, 'ai', ${season.id}, ${aiLevelFor(cfg, row)})
    on conflict (user_id, match_key) do nothing
  `;
  // a retried start returns the same match (and its level); a finished one cannot start again
  const [match] = await sql`select ai_level, finished_at from ranked_matches where user_id = ${userId} and match_key = ${key}`;
  if (match.finished_at) throw httpError(409, "match_finished");
  return { row, season, seasonReward, settled, aiLevel: Number(match.ai_level) };
}

export async function reportMatch(sql, userId, cfg, body) {
  const key = String(body.matchKey || "").slice(0, 80);
  const result = ["win", "lose", "draw"].includes(body.result) ? body.result : "lose";
  const turns = int(body.turns, 0, 10_000, 0);
  let { row, season, seasonReward, settled } = await loadRank(sql, userId, cfg);
  const [match] = await sql`select finished_at from ranked_matches where user_id = ${userId} and match_key = ${key}`;
  if (!match) throw httpError(404, "unknown_match");
  let outcome = null;
  if (!match.finished_at) {
    const r = await finishMatch(sql, userId, cfg, row, key, result, turns, season);
    if (r) { row = r.row; outcome = r.outcome; }
  }
  if (!outcome) {
    // reported again (a retry), or already counted as a loss: the stored result, nothing changes
    const [m] = await sql`select result, delta, points_after from ranked_matches where user_id = ${userId} and match_key = ${key}`;
    outcome = { matchKey: key, result: m.result, delta: Number(m.delta || 0), points: row.points, league: leagueOf(cfg, row.points).league, already: true, rewards: [] };
  }
  return { row, season, seasonReward, settled, outcome };
}

/** What the app shows: the season, the player's points and league, the computer's next levels, the league table. */
export async function publicStatus(sql, userId, cfg, loaded) {
  const { row, season } = loaded;
  const [u] = await sql`select nickname from app_users where id = ${userId}`;
  const league = leagueOf(cfg, row.points);
  return {
    season,
    points: row.points,
    league: league.league,
    best: row.best_league,
    streak: row.streak,
    games: row.games,
    wins: row.wins,
    cap: cfg.cap,
    nickname: u?.nickname || null,
    aiLevel: aiLevelFor(cfg, row),
    unrankedAiLevel: league.aiLevel,
    leagues: cfg.leagues.map(l => ({ league: l.league, min: l.min, he: l.he, en: l.en, win: l.win, loss: l.loss, floor: l.floor, aiPercent: l.aiPercent, reward: l.reward, seasonReward: l.seasonReward })),
    seasonReward: loaded.seasonReward || null,
    settled: loaded.settled || []
  };
}

/** The top of the current season and the player's own place (ties: who reached the points first). */
export async function leaderboard(sql, cfg, userId, limit = 100) {
  const season = seasonAt(cfg);
  const top = await sql`
    select u.nickname, r.points, r.user_id = ${userId ?? null}::uuid as me
    from player_ranks r join app_users u on u.id = r.user_id
    where r.season = ${season.id} and r.games > 0
    order by r.points desc, r.reached_at asc
    limit ${limit}
  `;
  let mine = null;
  if (userId) {
    const [me] = await sql`select points, reached_at, games from player_ranks where user_id = ${userId} and season = ${season.id}`;
    if (me && Number(me.games) > 0) {
      const [pos] = await sql`
        select count(*)::int + 1 as place from player_ranks
        where season = ${season.id} and games > 0 and (points > ${me.points} or (points = ${me.points} and reached_at < ${me.reached_at}))
      `;
      mine = { place: pos.place, points: Number(me.points) };
    }
  }
  return {
    season,
    top: top.map((r, i) => ({ place: i + 1, nickname: r.nickname || "Gardener", points: Number(r.points), league: leagueOf(cfg, Number(r.points)).league, me: r.me })),
    mine
  };
}

// ---------------------------------------------------------------- back office

export async function distribution(sql, cfg) {
  const season = seasonAt(cfg);
  const rows = await sql`select points from player_ranks where season = ${season.id} and games > 0`;
  const counts = Object.fromEntries(cfg.leagues.map(l => [l.league, 0]));
  for (const r of rows) counts[leagueOf(cfg, Number(r.points)).league]++;
  return { season, players: rows.length, leagues: cfg.leagues.map(l => ({ league: l.league, he: l.he, en: l.en, players: counts[l.league] })) };
}

/** Sets a player's points by hand (support), logged with the admin and a note. */
export async function adminAdjust(sql, cfg, adminId, { userId, points, note }) {
  const target = String(userId || "");
  if (!UUID.test(target)) throw httpError(400, "bad_user");
  const value = int(points, 0, cfg.cap, null);
  if (value === null) throw httpError(400, "bad_points");
  const { row } = await loadRank(sql, target, cfg);
  const league = leagueOf(cfg, value).league;
  await sql`update player_ranks set points = ${value}, best_league = greatest(best_league, ${league}),
    reached_at = case when ${value} > points then now() else reached_at end, updated_at = now() where user_id = ${target}`;
  await sql`insert into rank_events (user_id, kind, detail, created_by) values (${target}, 'admin_adjust',
    ${JSON.stringify({ before: row.points, after: value, note: String(note || "").slice(0, 200) })}::jsonb, ${adminId})`;
  return { before: row.points, after: value };
}

export async function adminResetNickname(sql, adminId, userId) {
  const target = String(userId || "");
  const [u] = await sql`select nickname from app_users where id::text = ${target}`;
  if (!u) throw httpError(404, "not_found");
  await sql`update app_users set nickname = null where id::text = ${target}`;
  const name = await ensureNickname(sql, target);
  await sql`insert into rank_events (user_id, kind, detail, created_by) values (${target}, 'nickname_reset',
    ${JSON.stringify({ before: u.nickname, after: name })}::jsonb, ${adminId})`;
  return name;
}

/** A player's rank for the back office players page (null before their first ranked game). */
export async function playerRank(sql, cfg, userId) {
  try {
    const [r] = await sql`select * from player_ranks where user_id = ${userId}`;
    if (!r) return null;
    const row = numRow(r);
    const events = await sql`select kind, detail, created_at from rank_events where user_id = ${userId} order by created_at desc limit 10`;
    const matches = await sql`select match_key, result, turns, delta, points_after, ai_level, started_at, finished_at from ranked_matches
      where user_id = ${userId} order by started_at desc limit 10`;
    return { season: row.season, points: row.points, league: leagueOf(cfg, row.points).league, best: row.best_league, streak: row.streak, games: row.games, wins: row.wins, events, matches };
  } catch { return null; }
}
