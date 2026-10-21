// Checks the computer decks and difficulty levels against a test database branch.
//   DATABASE_URL=<test branch> node scripts/aidecks-test.mjs
import { neon } from "@neondatabase/serverless";
import { loadCatalog, rewardMatch, aiGamesPlayed } from "../netlify/functions/_lib/economy.mjs";
import { deleteDeck, loadLevels, normalizeDeckConfig, normalizeLevels, publicAiConfig, saveDeck, saveLevels } from "../netlify/functions/_lib/aidecks.mjs";

const sql = neon(process.env.DATABASE_URL);
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const throws = fn => { try { fn(); return null; } catch (e) { return e.publicCode || e.message; } };

const catalog = await loadCatalog(sql);
const monsters = catalog.filter(c => !c.god && c.kind === "monster");
const spells = catalog.filter(c => !c.god && c.kind === "spell");
const gods = catalog.filter(c => c.god);
check(`catalog has monsters, spells and gods (${monsters.length}/${spells.length}/${gods.length})`, monsters.length > 10 && spells.length > 3 && gods.length > 0);

// fully random, mixed, fully fixed
check("random deck accepted", throws(() => normalizeDeckConfig({ random: { monsters: 22, spells: 8, gods: 1 } }, catalog)) === null);
check("too few cards refused", throws(() => normalizeDeckConfig({ random: { monsters: 20, spells: 5, gods: 1 } }, catalog)) === "invalid_deck");
check("no god refused", throws(() => normalizeDeckConfig({ random: { monsters: 22, spells: 8 } }, catalog)) === "invalid_deck");
check("more than 3 random gods capped at 3", normalizeDeckConfig({ random: { monsters: 22, spells: 8, gods: 4 } }, catalog).random.gods === 3);
const fixed = Object.fromEntries(monsters.slice(0, 5).map(c => [c.id, 4]));
fixed[gods[0].id] = 1;
const mixed = normalizeDeckConfig({ fixed, random: { monsters: 5, spells: 5, rarities: ["bronze", "silver", "nonsense"] } }, catalog);
check("mixed deck: 20 fixed + 10 random", Object.values(mixed.fixed).reduce((a, b) => a + b, 0) === 21 && mixed.random.monsters === 5);
check("unknown rarities dropped", mixed.random.rarities.join() === "bronze,silver");
check("copies capped at 4, gods at 1", normalizeDeckConfig({ fixed: { ...fixed, [monsters[6].id]: 9, [gods[0].id]: 3 }, random: { monsters: 6, spells: 0 } }, catalog).fixed[monsters[6].id] === 4);
check("unknown card refused", throws(() => normalizeDeckConfig({ fixed: { nope: 2 }, random: { monsters: 30, gods: 1 } }, catalog)) === "invalid_deck");
check("impossible rarity mix refused", throws(() => normalizeDeckConfig({ random: { monsters: 0, spells: 40, gods: 1, rarities: ["diamond"] } }, catalog)) === "invalid_deck");

// levels
const lv = normalizeLevels({ levels: [{ level: 1, maxGames: 2 }, { level: 2, maxGames: 3 }, { level: 3, maxGames: 2 }] });
check("10 levels, thresholds always grow, the last is open", lv.length === 10 && lv[1].maxGames === 3 && lv[2].maxGames === 4 && lv[9].maxGames === null);

// save, assign, public config, delete
const before = await loadLevels(sql);
let id = null;
try {
  id = await saveDeck(sql, { name: "test deck", config: { fixed, random: { monsters: 5, spells: 5 } } }, null);
  await saveLevels(sql, { levels: before.map(l => (l.level === 3 ? { ...l, deckId: id } : l)) }, null);
  const pub = await publicAiConfig(sql);
  check("public config carries the deck of level 3", pub.levels[2].deck?.random?.spells === 5 && pub.levels[0].deck === null);
  await deleteDeck(sql, id, null);
  id = null;
  check("deleting a deck frees its level", (await loadLevels(sql))[2].deckId === null);
} finally {
  if (id) await deleteDeck(sql, id, null);
  await saveLevels(sql, { levels: before }, null);
}

// finished games are counted (rewarded or not)
const [user] = await sql`select id from app_users order by created_at limit 1`;
if (user) {
  const n0 = await aiGamesPlayed(sql, user.id);
  const key = "aitest" + Date.now();
  await rewardMatch(sql, user.id, { mode: "ai", result: "lose", turns: 1, matchKey: key });
  await rewardMatch(sql, user.id, { mode: "ai", result: "lose", turns: 1, matchKey: key });
  check("a short game counts once", await aiGamesPlayed(sql, user.id) === n0 + 1);
  await sql`delete from match_results where user_id = ${user.id} and match_key = ${key}`;
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
