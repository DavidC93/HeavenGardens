import { api } from "./api.js";
import { h, clear, icon, toast } from "./dom.js";
import { t } from "./i18n.js";
import { rules, rarityName, RARITY_COLORS } from "./rules.js";
import { allCards, artUrl, findCard, kindOf } from "./cards.js";

// The computer opponent: its decks (fixed cards, random rules, or both) and the 10 difficulty levels.
const DECK_MIN = 30, DECK_MAX = 40, MAX_COPIES = 4, MIN_GODS = 1, MAX_GODS = 3;
let data = null; // { levels: [{ level, maxGames, deckId }], decks: [{ id, name, config }] }

async function load() {
  const res = await api.get("ai-config?admin=1");
  if (!res.ok) throw new Error(res.data.error || "network");
  data = res.data;
}

// ------------------------------------------------------------------ overview: levels and decks

export async function renderAi(root) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  try { await load(); } catch { clear(root).append(h("div", { class: "empty" }, t("networkError"))); return; }
  clear(root);

  const rows = data.levels.map(l => {
    const games = h("input", { class: "input", type: "number", min: "1", step: "1", dir: "ltr", value: l.maxGames ?? "", disabled: l.maxGames === null });
    const deck = h("select", { class: "input" },
      h("option", { value: "" }, t("aiBuiltIn")),
      data.decks.map(d => h("option", { value: d.id, selected: d.id === l.deckId }, d.name)));
    return { level: l.level, games, deck, el: h("tr", {},
      h("td", {}, h("b", {}, t("aiLevel", l.level))),
      h("td", {}, l.maxGames === null ? h("span", { class: "muted" }, t("aiAbove", data.levels[8].maxGames)) : h("div", { class: "games-cell" }, h("span", { class: "muted small" }, t("aiUpTo")), games, h("span", { class: "muted small" }, t("aiGames")))),
      h("td", {}, deck)) };
  });
  const saveLevels = h("button", { type: "button", class: "btn primary", onclick: async () => {
    saveLevels.disabled = true;
    const levels = rows.map(r => ({ level: r.level, maxGames: r.games.disabled ? null : Number(r.games.value), deckId: r.deck.value || null }));
    const res = await api.post("ai-config", { action: "saveLevels", levels });
    saveLevels.disabled = false;
    if (!res.ok) { toast(res.data.message || t("networkError"), "error"); return; }
    toast(t("settingsSaved"));
    renderAi(root);
  } }, icon("save"), t("save"));

  const deckList = h("div", { class: "ai-decks" });
  if (data.decks.length === 0) deckList.append(h("div", { class: "empty" }, t("aiNoDecks")));
  for (const d of data.decks) {
    const used = data.levels.filter(l => l.deckId === d.id).map(l => l.level);
    deckList.append(h("a", { class: "ai-deck-row", href: `#/ai/${d.id}` },
      h("div", { class: "grow" },
        h("div", { class: "player-name" }, d.name),
        h("div", { class: "muted small" }, describe(d.config))),
      used.length ? h("span", { class: "badge" }, t("aiUsedBy", used.join(", "))) : null));
  }

  root.append(
    h("section", { class: "panel" },
      h("h2", {}, t("aiLevelsTitle")),
      h("p", { class: "hint" }, t("aiLevelsHint")),
      h("table", { class: "ai-levels" }, h("tbody", {}, rows.map(r => r.el))),
      h("div", { class: "toolbar" }, saveLevels)),
    h("section", { class: "panel" },
      h("div", { class: "toolbar" }, h("h2", { class: "grow" }, t("aiDecksTitle")), h("a", { class: "btn primary", href: "#/ai/new" }, icon("plus"), t("aiNewDeck"))),
      deckList));
}

function describe(config) {
  const fixed = Object.entries(config.fixed || {});
  const fixedCards = fixed.filter(([id]) => kindOf(findCard(id) || {}) !== "god").reduce((s, [, n]) => s + n, 0);
  const fixedGods = fixed.length - fixed.filter(([id]) => kindOf(findCard(id) || {}) !== "god").length;
  const r = config.random || {};
  const parts = [];
  if (fixedCards || fixedGods) parts.push(t("aiFixedSummary", fixedCards, fixedGods));
  if (r.monsters || r.spells || r.gods) parts.push(t("aiRandomSummary", r.monsters || 0, r.spells || 0, r.gods || 0, (r.rarities || []).map(rarityName).join("/")));
  return parts.join(" · ");
}

// ------------------------------------------------------------------ one deck

export async function renderAiDeck(root, id) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  if (!data) { try { await load(); } catch { clear(root).append(h("div", { class: "empty" }, t("networkError"))); return; } }
  const existing = id === "new" ? null : data.decks.find(d => d.id === id);
  if (id !== "new" && !existing) { clear(root).append(h("a", { class: "btn ghost", href: "#/ai" }, icon("back"), t("back")), h("div", { class: "empty" }, t("aiNotFound"))); return; }

  const allRarities = rules.rarities.map(r => r.id);
  const draft = {
    name: existing?.name || "",
    fixed: { ...(existing?.config.fixed || {}) },
    random: { monsters: 0, spells: 0, gods: 0, rarities: [...allRarities], godRarities: [...allRarities], ...(existing?.config.random || {}) },
  };

  clear(root);
  const name = h("input", { class: "input", value: draft.name, maxlength: "60", placeholder: t("aiDeckName"), oninput: e => { draft.name = e.target.value; } });
  const summary = h("div", { class: "ai-summary" });
  const chosen = h("div", { class: "ai-chosen" });
  const pool = h("div", { class: "ai-pool" });
  const filter = { q: "", kind: "monster" };

  const num = (key, max) => h("input", { class: "input", type: "number", min: "0", max: String(max), step: "1", dir: "ltr", value: String(draft.random[key] || 0),
    oninput: e => { draft.random[key] = Math.max(0, Math.min(max, Math.trunc(Number(e.target.value) || 0))); refresh(); } });
  const rarityBoxes = key => h("div", { class: "segmented" }, allRarities.map(r => {
    const b = h("button", { type: "button", class: draft.random[key].includes(r) ? "active" : "", style: { "--chip": RARITY_COLORS[r] }, onclick: () => {
      const list = draft.random[key];
      const i = list.indexOf(r);
      if (i >= 0) { if (list.length > 1) list.splice(i, 1); } else list.push(r);
      b.classList.toggle("active", list.includes(r));
      refresh();
    } }, rarityName(r));
    return b;
  }));

  const kindChips = h("div", { class: "segmented" });
  for (const [value, label] of [["monster", t("monsters")], ["spell", t("spells")], ["god", t("gods")]]) {
    const b = h("button", { type: "button", class: filter.kind === value ? "active" : "", onclick: () => {
      filter.kind = value;
      for (const x of kindChips.children) x.classList.toggle("active", x === b);
      fillPool();
    } }, label);
    kindChips.append(b);
  }
  const search = h("input", { type: "search", class: "input grow", placeholder: t("searchCards"), oninput: e => { filter.q = e.target.value; fillPool(); } });

  const save = h("button", { type: "button", class: "btn primary", onclick: async () => {
    if (!draft.name.trim()) { toast(t("aiNeedName"), "error"); name.focus(); return; }
    save.disabled = true;
    const res = await api.post("ai-config", { action: "saveDeck", id: existing?.id, name: draft.name, config: { fixed: draft.fixed, random: draft.random } });
    save.disabled = false;
    if (!res.ok) { toast(res.data.message || t("networkError"), "error"); return; }
    toast(t("settingsSaved"));
    data = null;
    location.hash = "#/ai";
  } }, icon("save"), t("save"));
  const del = existing ? h("button", { type: "button", class: "btn ghost", onclick: async () => {
    if (!confirm(t("aiDeleteConfirm", existing.name))) return;
    const res = await api.post("ai-config", { action: "deleteDeck", id: existing.id });
    if (!res.ok) { toast(res.data.message || t("networkError"), "error"); return; }
    data = null;
    location.hash = "#/ai";
  } }, icon("close"), t("aiDelete")) : null;

  root.append(
    h("div", { class: "toolbar" }, h("a", { class: "btn ghost", href: "#/ai" }, icon("back"), t("back")), h("div", { class: "grow" }), del, save),
    h("section", { class: "panel" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("aiDeckName")), name),
      summary),
    h("section", { class: "panel" },
      h("h2", {}, t("aiRandomTitle")),
      h("p", { class: "hint" }, t("aiRandomHint")),
      h("div", { class: "ai-random" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, t("monsters")), num("monsters", DECK_MAX)),
        h("label", { class: "field" }, h("span", { class: "field-label" }, t("spells")), num("spells", DECK_MAX)),
        h("label", { class: "field" }, h("span", { class: "field-label" }, t("gods")), num("gods", MAX_GODS))),
      h("div", { class: "field" }, h("span", { class: "field-label" }, t("aiRarities")), rarityBoxes("rarities")),
      h("div", { class: "field" }, h("span", { class: "field-label" }, t("aiGodRarities")), rarityBoxes("godRarities"))),
    h("section", { class: "panel" },
      h("h2", {}, t("aiFixedTitle")),
      h("p", { class: "hint" }, t("aiFixedHint")),
      chosen,
      h("div", { class: "toolbar wrap" }, kindChips, h("div", { class: "search-box grow" }, icon("search"), search)),
      pool));

  function counts() {
    let cards = 0, gods = 0;
    for (const [cid, n] of Object.entries(draft.fixed)) { if (kindOf(findCard(cid) || {}) === "god") gods += n; else cards += n; }
    return { fixedCards: cards, fixedGods: gods, total: cards + draft.random.monsters + draft.random.spells, gods: gods + draft.random.gods };
  }

  function refresh() {
    const c = counts();
    const okCards = c.total >= DECK_MIN && c.total <= DECK_MAX, okGods = c.gods >= MIN_GODS && c.gods <= MAX_GODS;
    summary.replaceChildren(
      h("span", { class: okCards ? "ok" : "warn" }, t("aiTotalCards", c.total, DECK_MIN, DECK_MAX)),
      h("span", { class: okGods ? "ok" : "warn" }, t("aiTotalGods", c.gods, MIN_GODS, MAX_GODS)),
      h("span", { class: "muted" }, t("aiKind", c.fixedCards + c.fixedGods > 0 ? (draft.random.monsters + draft.random.spells + draft.random.gods > 0 ? "mixed" : "fixed") : "random")));
    save.disabled = !(okCards && okGods);
    clear(chosen);
    const entries = Object.entries(draft.fixed).map(([cid, n]) => [findCard(cid), n]).filter(([c]) => c)
      .sort(([a], [b]) => (kindOf(a) + a.id).localeCompare(kindOf(b) + b.id, "en", { numeric: true }));
    if (entries.length === 0) chosen.append(h("div", { class: "muted small" }, t("aiNoFixed")));
    for (const [card, n] of entries) chosen.append(h("div", { class: "ai-chosen-row", style: { "--rarity": RARITY_COLORS[card.rarity || "bronze"] } },
      h("span", { class: "ai-thumb", style: { backgroundImage: `url("${artUrl(card, 80)}")` } }),
      h("span", { class: "grow" }, card.name || card.id, h("span", { class: "muted small" }, " · ", rarityName(card.rarity || "bronze"))),
      h("button", { type: "button", class: "btn small sq", onclick: () => change(card, -1) }, "−"),
      h("b", { class: "ai-count" }, n),
      h("button", { type: "button", class: "btn small sq", onclick: () => change(card, +1) }, "+")));
    fillPool();
  }

  function change(card, delta) {
    const max = kindOf(card) === "god" ? 1 : MAX_COPIES;
    const n = Math.max(0, Math.min(max, (draft.fixed[card.id] || 0) + delta));
    if (n === 0) delete draft.fixed[card.id]; else draft.fixed[card.id] = n;
    refresh();
  }

  function fillPool() {
    clear(pool);
    const q = filter.q.trim().toLowerCase();
    const list = allCards().filter(c => kindOf(c) === filter.kind && (!q || [c.id, c.name, c.nameEn].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    for (const c of list) {
      const have = draft.fixed[c.id] || 0, max = kindOf(c) === "god" ? 1 : MAX_COPIES;
      pool.append(h("button", { type: "button", class: "ai-pool-card" + (have ? " picked" : ""), disabled: have >= max, title: c.name, style: { "--rarity": RARITY_COLORS[c.rarity || "bronze"] }, onclick: () => change(c, +1) },
        h("span", { class: "ai-pool-art", style: { backgroundImage: `url("${artUrl(c, 160)}")` } }, have ? h("span", { class: "ai-pool-count" }, have) : null),
        h("span", { class: "ai-pool-name" }, c.name || c.id)));
    }
  }

  refresh();
}
