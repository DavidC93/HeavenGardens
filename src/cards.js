import { api } from "./api.js";
import { h, clear, icon, toast } from "./dom.js";
import { t } from "./i18n.js";
import {
  rules, abilityName, abilityDesc, abilityColor, abilityBase, warName, war, rarityName, raceName, targetName, effect,
  effectName, maxAbilities, RARITY_COLORS,
} from "./rules.js";

// ------------------------------------------------------------------ data

let cards = [];
const filters = { q: "", kind: "all", rarity: "", war: "" };

export const kindOf = c => (c.god === true ? "god" : c.type === "spell" || c.kind === "spell" ? "spell" : "monster");

export async function loadCards() {
  const res = await api.get("cards");
  if (!res.ok) throw new Error(res.data.error || "network");
  cards = [...(res.data.monsterCards || []), ...(res.data.spellCards || [])];
  return cards;
}

export const findCard = id => cards.find(c => c.id === id);
export const allCards = () => cards;

/** Art for a card: Netlify's image CDN makes small thumbnails on the live site; locally the file itself. */
export function artUrl(card, width = 0) {
  let url = String(card?.imageUrl || "").trim() || `assets/cards/${card?.id}.png`;
  if (url.startsWith("data:") || /^https?:/.test(url)) return url;
  url = "/" + url.replace(/^\/+/, "");
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  return width && !local ? `/.netlify/images?url=${encodeURIComponent(url)}&w=${width}&fm=webp` : url;
}

// ------------------------------------------------------------------ list

export function renderCardList(root) {
  clear(root);
  const grid = h("div", { class: "card-grid" });
  const summary = h("div", { class: "muted small" });
  const kindChips = h("div", { class: "segmented" });
  for (const [value, label] of [["all", t("all")], ["monster", t("monsters")], ["spell", t("spells")], ["god", t("gods")]]) {
    kindChips.append(h("button", {
      type: "button", class: filters.kind === value ? "active" : "",
      onclick: () => { filters.kind = value; renderCardList(root); },
    }, label));
  }
  const search = h("input", {
    type: "search", class: "input grow", placeholder: t("searchCards"), value: filters.q,
    oninput: e => { filters.q = e.target.value; fill(); },
  });
  const rarity = h("select", { class: "input", onchange: e => { filters.rarity = e.target.value; fill(); } },
    h("option", { value: "" }, t("allRarities")),
    rules.rarities.map(r => h("option", { value: r.id, selected: filters.rarity === r.id }, rarityName(r.id))));
  const warSel = h("select", { class: "input", onchange: e => { filters.war = e.target.value; fill(); } },
    h("option", { value: "" }, t("allWars")),
    rules.wars.map(w => h("option", { value: w.id, selected: filters.war === w.id }, warName(w.id))));

  root.append(
    h("div", { class: "toolbar" },
      h("div", { class: "search-box grow" }, icon("search"), search),
      h("a", { class: "btn primary", href: "#/cards/new" }, icon("plus"), t("newCard"))),
    h("div", { class: "toolbar wrap" }, kindChips, rarity, warSel),
    summary, grid);

  function matches(c) {
    const kind = kindOf(c);
    if (filters.kind !== "all" && kind !== filters.kind) return false;
    if (filters.rarity && (c.rarity || "bronze") !== filters.rarity) return false;
    if (filters.war && c.war !== filters.war) return false;
    const q = filters.q.trim().toLowerCase();
    if (!q) return true;
    const text = [c.id, c.name, c.nameEn, c.race, c.war, c.desc, ...(c.abilities || []).map(a => abilityName(a))].join(" ").toLowerCase();
    return text.includes(q);
  }

  function fill() {
    clear(grid);
    const list = cards.filter(matches).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    summary.textContent = t("showing", list.length);
    if (list.length === 0) grid.append(h("div", { class: "empty" }, t("noCards")));
    for (const c of list) grid.append(cardTile(c));
  }
  fill();
}

function cardTile(c) {
  const kind = kindOf(c);
  const rarity = c.rarity || "bronze";
  return h("a", { class: `tile rarity-${rarity}`, href: `#/cards/${encodeURIComponent(c.id)}`, style: { "--rarity": RARITY_COLORS[rarity] } },
    h("div", { class: "tile-art", style: { backgroundImage: `url("${artUrl(c, 300)}")` } },
      h("span", { class: "cost-bubble" + (kind === "spell" ? " spell" : "") }, c.cost ?? 0)),
    h("div", { class: "tile-body" },
      h("div", { class: "tile-name" }, c.name || c.id),
      h("div", { class: "tile-meta" }, c.id, " · ", kind === "spell" ? effectName(c.effect) : warName(c.war)),
      kind !== "spell"
        ? h("div", { class: "tile-stats" },
            stat("sword", c.attack), stat("shield", c.defense), stat("heart", c.hp), stat("wing", c.speed))
        : null,
      (c.abilities || []).length
        ? h("div", { class: "tile-abilities" }, c.abilities.map(a => h("span", { class: "ability-dot", style: { background: abilityColor(a) }, title: abilityName(a) })))
        : null));
}

const stat = (name, value) => h("span", { class: "stat" }, icon(name, 13), value ?? "–");

// ------------------------------------------------------------------ editor

const clampStat = (v, min = 1, max = 99) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
let dirty = false;
export const isDirty = () => dirty;
export const clearDirty = () => { dirty = false; };

function nextId(kind) {
  const prefix = kind === "god" ? "g_" : "m_";
  const nums = cards.map(c => c.id).filter(id => id.startsWith(prefix)).map(id => parseInt(id.slice(2), 10)).filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return prefix + String(next).padStart(3, "0");
}

function blankCard(kind = "monster") {
  return {
    id: nextId(kind), type: "monster", kind: "monster", name: "", nameEn: "", cost: 3, rarity: "bronze",
    race: rules.races[0]?.id || "", war: rules.wars[0]?.id || "", attack: 3, defense: 2, hp: 5, speed: 50,
    abilities: [], desc: "", descEn: "", imageUrl: "",
  };
}

export function renderCardEditor(root, id, onDone) {
  const isNew = id === "new";
  const original = isNew ? null : findCard(id);
  if (!isNew && !original) { clear(root).append(h("div", { class: "empty" }, t("noCards"))); return; }
  // the whole card object is kept, so fields this page does not know survive a save
  const d = structuredClone(original || blankCard());
  d.abilities = [...(d.abilities || [])];
  let kind = kindOf(d);
  dirty = false;
  const changed = () => { dirty = true; refresh(); };

  clear(root);
  const form = h("div", { class: "editor-form" });
  const side = h("div", { class: "editor-side" });
  const saveBtn = h("button", { type: "button", class: "btn primary", onclick: save }, icon("save"), t("save"));
  root.append(
    h("div", { class: "toolbar" },
      h("a", { class: "btn ghost", href: "#/cards" }, icon("back"), t("back")),
      h("h2", { class: "grow title-sm" }, isNew ? t("newCard") : `${d.name || d.id}`),
      original ? h("span", { class: "muted small" }, t("version", original.version ?? 1)) : null,
      saveBtn),
    h("div", { class: "editor" }, form, side));

  // ---- fields
  const field = (label, control, hint) => h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("span", { class: "hint" }, hint) : null);
  const text = (key, opts = {}) => h(opts.area ? "textarea" : "input", {
    class: "input", value: d[key] ?? "", rows: opts.area ? 3 : undefined, dir: opts.dir, placeholder: opts.placeholder,
    oninput: e => { d[key] = e.target.value; changed(); },
  }, opts.area ? d[key] ?? "" : null);
  const num = (key, min, max) => {
    const input = h("input", { class: "input num", type: "number", inputmode: "numeric", min, max, value: d[key] ?? min,
      oninput: e => { d[key] = e.target.value === "" ? "" : Number(e.target.value); changed(); },
      onchange: e => { d[key] = clampStat(e.target.value, min, max); e.target.value = d[key]; changed(); } });
    const step = delta => () => { d[key] = clampStat((Number(d[key]) || 0) + delta, min, max); input.value = d[key]; changed(); };
    return h("div", { class: "stepper" },
      h("button", { type: "button", class: "btn ghost sq", onclick: step(-1), "aria-label": "-1" }, "−"), input,
      h("button", { type: "button", class: "btn ghost sq", onclick: step(1), "aria-label": "+1" }, "+"));
  };
  const segmented = (options, current, onPick, colors = {}) => h("div", { class: "segmented" },
    options.map(([value, label]) => h("button", {
      type: "button", class: value === current ? "active" : "", style: colors[value] ? { "--chip": colors[value] } : undefined,
      onclick: () => onPick(value),
    }, label)));

  function buildForm() {
    clear(form);
    form.append(field(t("type"), segmented([["monster", t("monster")], ["spell", t("spell")], ["god", t("god")]], kind, v => {
      const wasGod = kind === "god";
      kind = v;
      d.type = v === "spell" ? "spell" : "monster";
      d.kind = d.type;
      if (v === "god") {
        d.god = true;
        d.war = rules.godWar;
        if (!d.race) d.race = rules.godRace;
        if (isNew) d.id = nextId("god");
      } else {
        delete d.god;
        if (wasGod) {
          if (d.war === rules.godWar) d.war = rules.wars[0].id;
          d.abilities = d.abilities.slice(0, maxAbilities(false));
          if (isNew) d.id = nextId("monster");
        }
      }
      if (v === "spell") { d.target = d.target || "enemy"; d.effect = d.effect || "damage"; d.amount = d.amount ?? 1; }
      buildForm();
      changed();
    })));

    const idInput = h("input", { class: "input", dir: "ltr", value: d.id, readonly: !isNew,
      oninput: e => { d.id = e.target.value.trim(); changed(); } });
    form.append(
      h("div", { class: "row2" },
        field(t("id"), idInput, isNew ? t("idHint") : null),
        field(t("cost"), num("cost", 0, 99))),
      h("div", { class: "row2" },
        field(t("nameHe"), text("name")),
        field(t("nameEn"), text("nameEn", { dir: "ltr" }))),
      field(t("rarity"), segmented(rules.rarities.map(r => [r.id, rarityName(r.id)]), d.rarity || "bronze",
        v => { d.rarity = v; buildForm(); changed(); }, RARITY_COLORS)));

    if (kind !== "spell") {
      form.append(h("h3", { class: "section" }, t("stats")),
        h("div", { class: "row4" },
          field(t("attack"), num("attack", 1, 99)), field(t("defense"), num("defense", 1, 99)),
          field(t("hp"), num("hp", 1, 99)), field(t("speed"), num("speed", 1, 100))));

      // creature types: the ones in use plus the known list, and a free text for a new one
      const races = [...new Set([...rules.races.map(r => r.id), ...cards.map(c => c.race).filter(Boolean)])];
      const raceSel = h("select", { class: "input", onchange: e => {
        if (e.target.value === "__other") { raceOther.hidden = false; raceOther.focus(); return; }
        raceOther.hidden = true; d.race = e.target.value; changed();
      } },
        races.map(r => h("option", { value: r, selected: d.race === r }, raceName(r))),
        h("option", { value: "__other" }, t("otherRace")));
      const raceOther = h("input", { class: "input", placeholder: t("newRace"), hidden: true,
        oninput: e => { d.race = e.target.value.trim(); changed(); } });
      form.append(h("div", { class: "row2" },
        field(t("race"), h("div", { class: "col" }, raceSel, raceOther)),
        kind === "god" ? null : field(t("war"), h("select", { class: "input", onchange: e => { d.war = e.target.value; buildForm(); changed(); } },
          rules.wars.map(w => h("option", { value: w.id, selected: d.war === w.id }, warName(w.id)))), warHint(d.war))));

      form.append(h("h3", { class: "section" }, t("abilities"), " ",
        h("span", { class: "muted small" }, t("abilitiesOf", d.abilities.length, maxAbilities(kind === "god")))));
      form.append(abilityList());
    } else {
      form.append(h("h3", { class: "section" }, t("spellEffect")));
      const targetSel = h("select", { class: "input", onchange: e => { d.target = e.target.value; buildForm(); changed(); } },
        rules.spellTargets.map(x => h("option", { value: x.id, selected: d.target === x.id }, targetName(x.id))));
      const effectSel = h("select", { class: "input", onchange: e => { d.effect = e.target.value; buildForm(); changed(); } },
        rules.spellEffects.map(x => h("option", { value: x.id, selected: d.effect === x.id }, effectName(x.id))));
      const allowed = effect(d.effect)?.targets || [];
      const ok = allowed.length === 0 || allowed.includes(d.target);
      form.append(
        h("div", { class: "row3" }, field(t("target"), targetSel), field(t("effect"), effectSel), field(t("amount"), num("amount", 0, 99))),
        h("div", { class: "hint " + (ok ? "ok" : "warn") }, ok ? t("comboOk") : t("needsTarget", allowed.map(targetName).join(" / "))));
    }

    form.append(
      h("div", { class: "row2" },
        field(t("descHe"), text("desc", { area: true })),
        field(t("descEn"), text("descEn", { area: true, dir: "ltr" }))),
      field(t("imageUrl"), text("imageUrl", { dir: "ltr", placeholder: `assets/cards/${d.id}.png` }), t("imageHint", d.id)));
  }

  function warHint(warId) {
    const w = war(warId);
    if (!w) return null;
    const list = ids => (ids.length ? ids.map(warName).join(", ") : t("nobody"));
    return `${t("strongVs")}: ${list(w.strong)} · ${t("weakVs")}: ${list(w.weak)}`;
  }

  // ---- abilities: the chosen ones with their full description, and a searchable picker of all of them
  function abilityList() {
    const wrap = h("div", { class: "abilities" });
    const max = maxAbilities(kind === "god");
    d.abilities.forEach((a, i) => wrap.append(h("div", { class: "ability-row", style: { "--ab": abilityColor(a) } },
      h("span", { class: "ability-dot big" }),
      h("div", { class: "grow" }, h("div", { class: "ability-name" }, abilityName(a)), h("div", { class: "ability-desc" }, abilityDesc(a))),
      h("button", { type: "button", class: "btn ghost sq", "aria-label": t("removeAbility"), title: t("removeAbility"),
        onclick: () => { d.abilities.splice(i, 1); buildForm(); changed(); } }, icon("close")))));
    if (d.abilities.length < max)
      wrap.append(h("button", { type: "button", class: "btn ghost", onclick: openPicker }, icon("plus"), t("addAbility")));
    return wrap;
  }

  function openPicker() {
    const dialog = h("dialog", { class: "picker" });
    const list = h("div", { class: "picker-list" });
    const search = h("input", { type: "search", class: "input", placeholder: t("searchAbilities"), oninput: () => fill() });
    dialog.append(
      h("div", { class: "picker-head" }, h("h3", {}, t("chooseAbility")),
        h("button", { type: "button", class: "btn ghost sq", onclick: () => dialog.close(), "aria-label": "close" }, icon("close"))),
      search, list);
    const taken = new Set(d.abilities.map(abilityBase));
    function fill() {
      clear(list);
      const q = search.value.trim().toLowerCase();
      // grouped by ability, every level with its own description
      const groups = new Map();
      for (const a of rules.abilities) {
        const text = (abilityName(a.id) + " " + abilityDesc(a.id) + " " + a.id).toLowerCase();
        if (q && !text.includes(q)) continue;
        if (!groups.has(a.base)) groups.set(a.base, []);
        groups.get(a.base).push(a);
      }
      for (const [base, levels] of groups) {
        const used = taken.has(base);
        const group = h("div", { class: "picker-group" + (used ? " used" : "") });
        for (const a of levels)
          group.append(h("button", {
            type: "button", class: "picker-item", disabled: used, style: { "--ab": a.color },
            onclick: () => { d.abilities.push(a.id); dialog.close(); buildForm(); changed(); },
          },
            h("span", { class: "ability-dot big" }),
            h("span", { class: "grow" }, h("span", { class: "ability-name" }, abilityName(a.id)), h("span", { class: "ability-desc" }, abilityDesc(a.id)))));
        if (used) group.append(h("div", { class: "hint" }, t("sameAbility")));
        list.append(group);
      }
    }
    fill();
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
  }

  // ---- live preview of the card
  function refresh() {
    clear(side);
    side.append(h("h3", { class: "section" }, t("preview")), preview());
  }

  function preview() {
    const rarity = d.rarity || "bronze";
    return h("div", { class: `card-preview kind-${kind}`, style: { "--rarity": RARITY_COLORS[rarity] } },
      h("div", { class: "cp-art", style: { backgroundImage: `url("${artUrl(d)}")` } },
        h("span", { class: "cost-bubble" + (kind === "spell" ? " spell" : "") }, d.cost ?? 0),
        h("span", { class: "cp-name" }, d.name || "…")),
      h("div", { class: "cp-band" }, kind === "spell" ? t("spell") : `${d.race || ""} · ${warName(d.war)}`),
      h("div", { class: "cp-body" },
        kind === "spell"
          ? h("div", { class: "cp-desc" }, d.desc || `${effectName(d.effect)} · ${targetName(d.target)} · ${d.amount ?? 0}`)
          : [
              h("div", { class: "cp-abilities" }, d.abilities.map(a => h("span", { class: "ability-chip", style: { "--ab": abilityColor(a) } }, abilityName(a)))),
              h("div", { class: "tile-stats" }, stat("sword", d.attack), stat("shield", d.defense), stat("heart", d.hp), stat("wing", d.speed)),
            ]),
      h("div", { class: "cp-rarity" }, rarityName(rarity)));
  }

  // ---- save
  async function save() {
    const err = validate();
    if (err) { toast(err, "error"); return; }
    const card = structuredClone(d);
    if (kind !== "spell") for (const k of ["attack", "defense", "hp"]) card[k] = clampStat(card[k]);
    if (kind !== "spell") card.speed = clampStat(card.speed, 1, 100);
    card.cost = clampStat(card.cost, 0, 99);
    card.name = card.name.trim();
    card.nameEn = (card.nameEn || "").trim();
    if (!card.nameEn) delete card.nameEn;
    if (!(card.descEn || "").trim()) delete card.descEn;
    card.imageUrl = (card.imageUrl || "").trim() || `assets/cards/${card.id}.png`;
    card.version = original?.version;
    delete card.updatedAt;
    saveBtn.disabled = true;
    saveBtn.lastChild.textContent = t("saving");
    const res = await api.post("cards", { card });
    saveBtn.disabled = false;
    saveBtn.lastChild.textContent = t("save");
    if (res.data?.cards) cards = [...(res.data.cards.monsterCards || []), ...(res.data.cards.spellCards || [])];
    if (res.status === 409) { toast(t("cardChanged"), "error"); dirty = false; renderCardEditor(root, card.id, onDone); return; }
    if (!res.ok) { toast(res.status === 0 ? t("networkError") : `${t("saveFailed")} (${res.data.error || res.status})`, "error"); return; }
    dirty = false;
    toast(t("saved"));
    onDone(card.id);
  }

  function validate() {
    if (!/^[a-z0-9_-]+$/i.test(d.id || "")) return t("idInvalid");
    if (isNew && findCard(d.id)) return t("idTaken");
    if (!(d.name || "").trim()) return t("nameRequired");
    return null;
  }

  buildForm();
  refresh();
}
