import { RARITIES, httpError, loadCatalog } from "./economy.mjs";

// Computer opponent: decks made in the back office and the 10 difficulty levels that use them.
// Deck rules (the same as a player's): 30–40 cards besides the gods, at most 4 copies of a card, 1–3 gods (one each).

export const DECK_MIN = 30, DECK_MAX = 40, MAX_COPIES = 4, MIN_GODS = 1, MAX_GODS = 3, LEVELS = 10;

const DEFAULT_LEVELS = [5, 10, 20, 30, 50, 80, 120, 160, 200, null].map((maxGames, i) => ({ level: i + 1, maxGames, deckId: null }));
const int = (v, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(v) || 0)));

/**
 * Checks a deck config against the catalog and returns it cleaned up:
 * { fixed: {id: n}, random: { monsters, spells, gods, rarities[], godRarities[] } }.
 * Throws 400 invalid_deck with a readable reason.
 */
export function normalizeDeckConfig(raw, catalog) {
  const byId = new Map(catalog.map(c => [c.id, c]));
  const fixed = {};
  let fixedCards = 0, fixedGods = 0;
  for (const [id, n] of Object.entries(raw?.fixed || {})) {
    const card = byId.get(id);
    if (!card) throw httpError(400, "invalid_deck", `Unknown card ${id}`);
    const copies = int(n, 0, card.god ? 1 : MAX_COPIES);
    if (copies === 0) continue;
    fixed[id] = copies;
    if (card.god) fixedGods++; else fixedCards += copies;
  }
  const r = raw?.random || {};
  const pickRarities = list => (Array.isArray(list) ? list : []).filter(x => RARITIES.includes(x));
  const random = {
    monsters: int(r.monsters, 0, DECK_MAX),
    spells: int(r.spells, 0, DECK_MAX),
    gods: int(r.gods, 0, MAX_GODS),
    rarities: pickRarities(r.rarities),
    godRarities: pickRarities(r.godRarities)
  };
  if (random.rarities.length === 0) random.rarities = [...RARITIES];
  if (random.godRarities.length === 0) random.godRarities = [...RARITIES];

  const total = fixedCards + random.monsters + random.spells;
  if (total < DECK_MIN || total > DECK_MAX) throw httpError(400, "invalid_deck", `The deck has ${total} cards (it needs ${DECK_MIN}–${DECK_MAX})`);
  const gods = fixedGods + random.gods;
  if (gods < MIN_GODS || gods > MAX_GODS) throw httpError(400, "invalid_deck", `The deck has ${gods} gods (it needs ${MIN_GODS}–${MAX_GODS})`);

  // the random part must be possible: enough distinct cards of the allowed rarities (copies limited to 4)
  const room = (kind, god, rarities) => catalog
    .filter(c => c.god === god && (god || c.kind === kind) && rarities.includes(c.rarity))
    .reduce((sum, c) => sum + (god ? 1 : MAX_COPIES) - (fixed[c.id] || 0), 0);
  if (random.monsters > room("monster", false, random.rarities)) throw httpError(400, "invalid_deck", "Not enough monsters of the chosen rarities");
  if (random.spells > room("spell", false, random.rarities)) throw httpError(400, "invalid_deck", "Not enough spells of the chosen rarities");
  if (random.gods > room(null, true, random.godRarities)) throw httpError(400, "invalid_deck", "Not enough gods of the chosen rarities");
  return { fixed, random };
}

export function normalizeLevels(raw, deckIds = null) {
  const given = Array.isArray(raw?.levels) ? raw.levels : [];
  let previous = 0;
  return DEFAULT_LEVELS.map(def => {
    const g = given.find(x => Number(x?.level) === def.level) || {};
    let maxGames = def.level === LEVELS ? null : int(g.maxGames ?? def.maxGames, 1, 1_000_000);
    if (maxGames !== null && maxGames <= previous) maxGames = previous + 1; // thresholds always grow
    if (maxGames !== null) previous = maxGames;
    const deckId = typeof g.deckId === "string" && (!deckIds || deckIds.has(g.deckId)) ? g.deckId : null;
    return { level: def.level, maxGames, deckId };
  });
}

export async function loadLevels(sql) {
  try {
    const [row] = await sql`select value from app_settings where key = 'ai_levels'`;
    return normalizeLevels(row?.value);
  } catch { return normalizeLevels(null); }
}

export async function saveLevels(sql, raw, adminId) {
  const ids = new Set((await sql`select id::text as id from ai_decks`).map(r => r.id));
  const levels = normalizeLevels(raw, ids);
  await sql`
    insert into app_settings (key, value, updated_at, updated_by)
    values ('ai_levels', ${JSON.stringify({ levels })}::jsonb, now(), ${adminId})
    on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
  `;
  return levels;
}

export async function listDecks(sql) {
  try {
    return await sql`select id::text as id, name, config, updated_at from ai_decks order by name`;
  } catch { return []; }
}

export async function saveDeck(sql, { id, name, config }, adminId) {
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!cleanName) throw httpError(400, "invalid_deck", "The deck needs a name");
  const clean = normalizeDeckConfig(config, await loadCatalog(sql));
  if (id) {
    const rows = await sql`
      update ai_decks set name = ${cleanName}, config = ${JSON.stringify(clean)}::jsonb, updated_at = now(), updated_by = ${adminId}
      where id::text = ${String(id)} returning id::text as id`;
    if (rows.length === 0) throw httpError(404, "not_found");
    return rows[0].id;
  }
  const [row] = await sql`
    insert into ai_decks (name, config, updated_by) values (${cleanName}, ${JSON.stringify(clean)}::jsonb, ${adminId})
    returning id::text as id`;
  return row.id;
}

/** Removes a deck; levels that used it go back to the built-in deck. */
export async function deleteDeck(sql, id, adminId) {
  await sql`delete from ai_decks where id::text = ${String(id)}`;
  const levels = (await loadLevels(sql)).map(l => (l.deckId === String(id) ? { ...l, deckId: null } : l));
  await saveLevels(sql, { levels }, adminId);
}

/** What the app needs: every level with its threshold and its deck config (null = built-in). */
export async function publicAiConfig(sql) {
  const [levels, decks] = await Promise.all([loadLevels(sql), listDecks(sql)]);
  const byId = new Map(decks.map(d => [d.id, d]));
  return {
    levels: levels.map(l => ({ level: l.level, maxGames: l.maxGames, deck: l.deckId && byId.get(l.deckId) ? byId.get(l.deckId).config : null }))
  };
}
