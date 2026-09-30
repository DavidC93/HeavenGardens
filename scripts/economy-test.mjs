// End-to-end test of the economy function against a TEST database branch (never production).
//   DATABASE_URL=<test branch> node scripts/economy-test.mjs
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { handler } from "../netlify/functions/economy.mjs";
import { ECONOMY, drawPack, rollRarity, RARITIES } from "../netlify/functions/_lib/economy.mjs";

const sql = neon(process.env.DATABASE_URL);
let failures = 0;
function check(ok, what) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
}

// ---- pure logic: odds
{
  let n = 0;
  const counts = {};
  let i = 0;
  const seq = () => { i = (i * 1103515245 + 12345) % 2147483648; return i / 2147483648; };
  for (; n < 200000; n++) { const r = rollRarity({ gold: 80, emerald: 17, diamond: 3 }, seq); counts[r] = (counts[r] || 0) + 1; }
  const pct = r => (100 * counts[r]) / n;
  check(Math.abs(pct("gold") - 80) < 1 && Math.abs(pct("emerald") - 17) < 1 && Math.abs(pct("diamond") - 3) < 0.5,
    `rarity odds follow the table (gold ${pct("gold").toFixed(1)} / emerald ${pct("emerald").toFixed(1)} / diamond ${pct("diamond").toFixed(1)})`);
  const catalog = [{ id: "a", rarity: "bronze", god: false }, { id: "g", rarity: "bronze", god: true }];
  const res = drawPack({ slots: [{ count: 10, odds: { bronze: 100 } }] }, catalog, { a: { count: 4 }, g: { count: 1 } });
  check(res.every(r => r.shards === ECONOMY.shardsPerCard), "cards owned 4 times (gods: once) become shards");
  const up = drawPack({ slots: [{ count: 1, odds: { diamond: 100 } }] }, [{ id: "b", rarity: "bronze" }], {});
  check(up.length === 1 && up[0].rarity === "bronze", "a rarity with no cards falls back to a lower one");
}

// ---- a throwaway test user with a session
const email = `economy-test-${Date.now()}@example.invalid`;
const [user] = await sql`insert into app_users (email, display_name, password_hash) values (${email}, 'Economy Test', 'x') returning id`;
const token = crypto.randomBytes(24).toString("base64url");
await sql`insert into user_sessions (user_id, token_hash, expires_at) values (${user.id}, ${crypto.createHash("sha256").update(token).digest("hex")}, now() + interval '1 hour')`;
const call = async (method, body, query) => {
  const res = await handler({ httpMethod: method, headers: { cookie: `hg_session=${token}` }, body: body ? JSON.stringify(body) : null, queryStringParameters: query || {} });
  return { status: res.statusCode, data: JSON.parse(res.body) };
};

try {
  const cfg = await handler({ httpMethod: "GET", headers: {}, queryStringParameters: { config: "1" } });
  check(cfg.statusCode === 200 && JSON.parse(cfg.body).config.packs.length === 3, "public config lists the three packs");
  const anon = await handler({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
  check(anon.statusCode === 401, "state needs a signed-in player");

  let r = await call("GET");
  const s0 = r.data.state;
  const starterCards = Object.values(ECONOMY.starter).reduce((a, b) => a + b, 0);
  const owned = Object.values(s0.cards).reduce((a, c) => a + c.count, 0);
  check(s0.coins === 1000 && s0.apples === 10, "starts with 1000 coins and 10 golden apples");
  check(owned === starterCards && owned === 31, `starter collection: ${owned} cards (30 + the god)`);
  check(Object.values(s0.cards).every(c => c.locked === c.count), "starter cards are locked");
  r = await call("GET");
  check(r.data.state.coins === 1000 && Object.keys(r.data.state.cards).length === Object.keys(s0.cards).length, "the starter set is granted once");

  r = await call("POST", { action: "disenchant", cardId: "m_016", amount: 1 });
  check(r.status === 400 && r.data.error === "cannot_disenchant", "starter copies cannot be disenchanted");

  r = await call("POST", { action: "openPack", pack: "big" });
  check(r.status === 402, "not enough coins for the big pack (3000)");
  r = await call("POST", { action: "openPack", pack: "basic" });
  check(r.status === 200 && r.data.cards.length === 2 && r.data.state.coins === 0, `basic pack: 2 cards, 1000 coins paid (${r.data.cards?.map(c => c.cardId + ":" + c.rarity).join(", ")})`);
  const second = r.data.cards[1];
  check(["silver", "gold", "emerald"].includes(second.rarity), "the basic pack's second card is silver or better");
  r = await call("POST", { action: "openPack", pack: "basic" });
  check(r.status === 402 && r.data.state === undefined, "no coins left: refused and nothing changes");

  // rewards
  r = await call("POST", { action: "reward", mode: "ai", result: "win", turns: 3, matchKey: "short-game-1" });
  check(r.data.coins === 0 && r.data.reason === "too_short", "a game shorter than 6 turns earns nothing");
  r = await call("POST", { action: "reward", mode: "ai", result: "win", turns: 9, matchKey: "ai-game-0001" });
  check(r.data.coins === 500 && r.data.state.coins === 500, "win against the computer: +500");
  r = await call("POST", { action: "reward", mode: "ai", result: "lose", turns: 9, matchKey: "ai-game-0002" });
  check(r.data.coins === 0 && r.data.reason === "too_fast", "computer rewards are at least 45 s apart");
  r = await call("POST", { action: "reward", mode: "online", result: "win", turns: 12, matchKey: "online-match-1" });
  check(r.data.coins === 1000 && r.data.state.coins === 1500, "online win: +1000");
  r = await call("POST", { action: "reward", mode: "online", result: "win", turns: 12, matchKey: "online-match-1" });
  check(r.data.coins === 0 && r.data.reason === "already_rewarded", "the same match pays once");
  r = await call("POST", { action: "reward", mode: "online", result: "lose", turns: 12, matchKey: "online-match-2" });
  check(r.data.coins === 500 && r.data.state.coins === 2000, "online loss: +500");

  // premium pack with apples (give some directly in the test database)
  await sql`update player_wallets set apples = 60 where user_id = ${user.id}`;
  r = await call("POST", { action: "openPack", pack: "premium" });
  const prem = r.data.cards || [];
  check(r.status === 200 && prem.length === 5 && r.data.state.apples === 10, `premium pack: 5 cards for 50 apples (${prem.map(c => c.rarity).join(", ")})`);
  check(["gold", "emerald", "diamond"].includes(prem[3]?.rarity) && ["gold", "emerald", "diamond"].includes(prem[4]?.rarity), "premium: the last two cards are gold or better");

  // disenchant an unlocked copy and craft
  const loose = Object.entries(r.data.state.cards).find(([, c]) => c.count > c.locked);
  if (loose) {
    const before = r.data.state;
    const card = (await sql`select payload->>'rarity' as rarity from cards where id = ${loose[0]}`)[0];
    r = await call("POST", { action: "disenchant", cardId: loose[0], amount: 1 });
    check(r.status === 200 && r.data.state.shards[card.rarity || "bronze"] === before.shards[card.rarity || "bronze"] + 5, `disenchanting ${loose[0]} gives 5 ${card.rarity} shards`);
  }
  await sql`insert into player_shards (user_id, rarity, amount) values (${user.id}, 'gold', 60) on conflict (user_id, rarity) do update set amount = 60`;
  const goldCard = (await sql`select id from cards where active and payload->>'rarity' = 'gold' and coalesce((payload->>'god')::boolean, false) = false order by id limit 1`)[0].id;
  const had = r.data.state.cards[goldCard]?.count || 0;
  r = await call("POST", { action: "craft", cardId: goldCard });
  check(r.status === 200 && r.data.state.shards.gold === 10 && r.data.state.cards[goldCard].count === had + 1, `50 gold shards craft a gold card (${goldCard})`);
  r = await call("POST", { action: "craft", cardId: goldCard });
  check(r.status === 400, "not enough shards: refused");

  r = await call("POST", { action: "grant", coins: 5000 });
  check(r.status === 403, "only admins can grant currency");
} finally {
  await sql`delete from app_users where id = ${user.id}`;
}
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
