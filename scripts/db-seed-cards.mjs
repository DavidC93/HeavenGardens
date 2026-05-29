import fs from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing DATABASE_URL or NETLIFY_DATABASE_URL.");
  process.exit(1);
}

function extractConstArray(source, name) {
  const marker = `const ${name} = [`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Could not find ${name}`);

  const start = markerIndex + marker.length - 1;
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) {
        const arrayText = source.slice(start, i + 1);
        return Function(`"use strict"; return (${arrayText});`)();
      }
    }
  }

  throw new Error(`Could not parse ${name}`);
}

function normalizeCard(card, kind) {
  return {
    ...card,
    type: kind,
    abilities: Array.isArray(card.abilities) ? card.abilities : []
  };
}

function columns(card) {
  const kind = card.type;
  return {
    id: String(card.id || "").trim(),
    kind,
    name: String(card.name || "").trim(),
    cost: Number(card.cost || 0),
    imageUrl: card.imageUrl || "",
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
    description: card.desc || "",
    abilities: JSON.stringify(card.abilities || []),
    payload: JSON.stringify(card)
  };
}

const source = await fs.readFile("public/legacy-card-battle.html", "utf8");
const monsters = extractConstArray(source, "CARD_POOL").map(card => normalizeCard(card, "monster"));
const spells = extractConstArray(source, "SPELL_POOL").map(card => normalizeCard(card, "spell"));
const sql = neon(databaseUrl);

for (const card of [...monsters, ...spells]) {
  const c = columns(card);
  await sql`
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
      active = true
  `;
}

console.log(`Seeded ${monsters.length} monster cards and ${spells.length} spell cards.`);

