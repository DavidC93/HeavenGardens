import { db } from "./_lib/db.mjs";
import { requireAdmin } from "./_lib/auth.mjs";
import { handleError, json, methodNotAllowed, readJson } from "./_lib/http.mjs";

function rowToCard(row) {
  return {
    ...(row.payload || {}),
    type: row.kind,
    id: row.id,
    imageUrl: row.image_url || row.payload?.imageUrl || "",
    emoji: row.emoji || row.payload?.emoji || "",
    accent: row.accent || row.payload?.accent || "",
    name: row.name,
    cost: Number(row.cost || 0),
    race: row.race || "",
    war: row.war || "",
    attack: row.attack ?? undefined,
    defense: row.defense ?? undefined,
    hp: row.hp ?? undefined,
    speed: row.speed ?? undefined,
    target: row.target || undefined,
    effect: row.effect || undefined,
    amount: row.amount ?? undefined,
    desc: row.description || row.payload?.desc || "",
    abilities: Array.isArray(row.abilities) ? row.abilities : []
  };
}

function cardToColumns(card) {
  const kind = card.kind || card.type || "monster";
  return {
    id: String(card.id || "").trim(),
    kind,
    name: String(card.name || "").trim(),
    cost: Number(card.cost || 0),
    imageUrl: card.imageUrl || card.image_url || "",
    emoji: card.emoji || "",
    accent: card.accent || "",
    race: kind === "monster" ? card.race || "" : null,
    war: kind === "monster" ? card.war || "" : null,
    attack: kind === "monster" ? Number(card.attack || 1) : null,
    defense: kind === "monster" ? Number(card.defense || 0) : null,
    hp: kind === "monster" ? Number(card.hp || 1) : null,
    speed: kind === "monster" ? Number(card.speed || 1) : null,
    target: kind === "spell" ? card.target || "none" : null,
    effect: kind === "spell" ? card.effect || "draw" : null,
    amount: kind === "spell" ? Number(card.amount || 0) : null,
    description: card.desc || card.description || "",
    abilities: JSON.stringify(Array.isArray(card.abilities) ? card.abilities : []),
    payload: JSON.stringify(card)
  };
}

async function listCards() {
  const rows = await db()`
    select *
    from cards
    where active = true
    order by kind, id
  `;
  const cards = rows.map(rowToCard);
  return {
    monsterCards: cards.filter(card => card.type === "monster"),
    spellCards: cards.filter(card => card.type === "spell")
  };
}

export async function handler(event) {
  try {
    if (event.httpMethod === "GET") return json(200, await listCards());
    if (!["POST", "PUT", "PATCH"].includes(event.httpMethod)) return methodNotAllowed(["GET", "POST", "PUT", "PATCH"]);

    await requireAdmin(event);
    const body = await readJson(event);
    const card = body.card || body;
    const c = cardToColumns(card);
    if (!c.id || !c.name) return json(400, { error: "invalid_card" });

    await db()`
      insert into cards (
        id, kind, name, cost, image_url, emoji, accent, race, war,
        attack, defense, hp, speed, target, effect, amount, description,
        abilities, payload, active, version
      )
      values (
        ${c.id}, ${c.kind}, ${c.name}, ${c.cost}, ${c.imageUrl}, ${c.emoji}, ${c.accent},
        ${c.race}, ${c.war}, ${c.attack}, ${c.defense}, ${c.hp}, ${c.speed},
        ${c.target}, ${c.effect}, ${c.amount}, ${c.description},
        ${c.abilities}::jsonb, ${c.payload}::jsonb, true, 1
      )
      on conflict (id) do update set
        kind = excluded.kind,
        name = excluded.name,
        cost = excluded.cost,
        image_url = excluded.image_url,
        emoji = excluded.emoji,
        accent = excluded.accent,
        race = excluded.race,
        war = excluded.war,
        attack = excluded.attack,
        defense = excluded.defense,
        hp = excluded.hp,
        speed = excluded.speed,
        target = excluded.target,
        effect = excluded.effect,
        amount = excluded.amount,
        description = excluded.description,
        abilities = excluded.abilities,
        payload = excluded.payload,
        active = true,
        version = cards.version + 1
    `;

    return json(200, { ok: true, cards: await listCards() });
  } catch (error) {
    return handleError(error);
  }
}

