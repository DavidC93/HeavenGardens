// Game rules exported from the Unity project (Heaven Gardens/Setup/Export Game Rules): abilities with their full
// descriptions, warfare types, spell targets and effects, rarities and limits.
import { lang } from "./i18n.js";

export let rules = null;

export async function loadRules() {
  const res = await fetch("/data/game-rules.json", { cache: "no-cache" });
  rules = await res.json();
  return rules;
}

const pick = text => (text && typeof text === "object" ? text[lang] || text.he || "" : text || "");

export const ability = id => rules.abilities.find(a => a.id === id);
export const abilityName = id => pick(ability(id)?.name) || id;
export const abilityDesc = id => pick(ability(id)?.desc);
export const abilityColor = id => ability(id)?.color || "#888";
export const abilityBase = id => ability(id)?.base || id.replace(/\d+$/, "");
export const warName = id => (id === rules.godWar ? pick({ he: "אל", en: "God" }) : pick(rules.wars.find(w => w.id === id)?.name) || id || "");
export const war = id => rules.wars.find(w => w.id === id);
export const rarityName = id => pick(rules.rarities.find(r => r.id === id)?.name) || id;
export const raceName = id => pick(rules.races.find(r => r.id === id)?.name) || id;
export const targetName = id => pick(rules.spellTargets.find(x => x.id === id)?.name) || id;
export const effect = id => rules.spellEffects.find(x => x.id === id);
export const effectName = id => pick(effect(id)?.name) || id;
export const maxAbilities = isGod => (isGod ? rules.limits.maxGodAbilities : rules.limits.maxAbilities);

export const RARITY_COLORS = {
  bronze: "#d38c4d",
  silver: "#d1d8e6",
  gold: "#ffd04d",
  emerald: "#4cf28c",
  diamond: "#b3f2ff",
};
