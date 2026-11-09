import { api } from "./api.js";
import { h, clear, icon, toast, fmt } from "./dom.js";
import { t } from "./i18n.js";
import { rules, rarityName, RARITY_COLORS } from "./rules.js";
import { allCards, artUrl, kindOf } from "./cards.js";

let lastQuery = "";

/** The player id the game shows in Settings (players quote it when they contact us). */
export const playerCode = id => "HG-" + String(id || "").replace(/-/g, "").slice(0, 10).toUpperCase();

let lastSort = "recent";

/** "לפני 5 דק׳" style age of a date (or "—"). */
export function ago(date) {
  if (!date) return "—";
  const min = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (min < 2) return t("agoNow");
  if (min < 60) return t("agoMin", min);
  const hours = Math.round(min / 60);
  if (hours < 24) return t("agoHours", hours);
  const days = Math.round(hours / 24);
  return days < 30 ? t("agoDays", days) : new Date(date).toLocaleDateString("he-IL");
}

/** How fresh an activity is: "hot" (today), "warm" (this week) or "" (older / never). */
const freshness = date => !date ? "" : Date.now() - new Date(date).getTime() < 864e5 ? "hot" : Date.now() - new Date(date).getTime() < 7 * 864e5 ? "warm" : "";

const signInName = p => [p.providers?.includes("google_play") ? t("playGames") : null, p.email ? t("email") : null].filter(Boolean).join(" + ") || "—";
const buildName = c => (c ? String(c).replace("android/", "") : "");

export function renderPlayerList(root) {
  clear(root);
  const stats = h("div", { class: "stat-row" });
  const list = h("div", { class: "player-list" });
  const search = h("input", { type: "search", class: "input grow", placeholder: t("searchPlayers"), value: lastQuery });
  const sort = h("select", { class: "input", "aria-label": t("sortBy"), onchange: () => { lastSort = sort.value; run(); } },
    ["recent", "new", "games"].map(v => h("option", { value: v, selected: v === lastSort }, t("sort." + v))));
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  root.append(h("div", { class: "toolbar wrap" }, h("div", { class: "search-box grow" }, icon("search"), search), sort), stats, list,
    h("div", { class: "hint" }, t("playersHint")));

  async function run() {
    lastQuery = search.value.trim();
    list.replaceChildren(h("div", { class: "muted" }, t("loading")));
    const res = await api.get(`admin-players?q=${encodeURIComponent(lastQuery)}&sort=${lastSort}`);
    clear(list);
    if (!res.ok) { list.append(h("div", { class: "empty" }, t("networkError"))); return; }
    const s = res.data.stats;
    if (s) stats.replaceChildren(
      bigStat(t("statTotal"), fmt(s.total), "#9db4ff"),
      bigStat(t("statDay"), fmt(s.day), "#4ade80"),
      bigStat(t("statWeek"), fmt(s.week), "#facc15"),
      bigStat(t("statPlayed"), fmt(s.played), "#c084fc"),
      bigStat(t("statNewWeek"), fmt(s.new_week), "#38bdf8"));
    if (res.data.players.length === 0) list.append(h("div", { class: "empty" }, t("noPlayers")));
    for (const p of res.data.players)
      list.append(h("a", { class: "player-row", href: `#/players/${p.id}` },
        h("span", { class: "dot " + freshness(p.last_active), title: p.last_active ? new Date(p.last_active).toLocaleString("he-IL") : t("neverSeen") }),
        h("div", { class: "grow" },
          h("div", { class: "player-name" }, p.display_name || p.email || p.id, p.role === "admin" ? h("span", { class: "badge" }, t("roleAdmin")) : null),
          h("div", { class: "muted small", dir: "ltr" }, playerCode(p.id), p.email ? " · " + p.email : ""),
          h("div", { class: "player-meta small" },
            h("span", {}, signInName(p)),
            h("span", {}, t("lastActive"), " ", h("b", {}, ago(p.last_active))),
            h("span", {}, t("gamesCount", p.games, p.wins)),
            p.last_client ? h("span", { dir: "ltr" }, "build ", buildName(p.last_client)) : null)),
        h("div", { class: "wallet" },
          h("span", { class: "coin" }, icon("coin", 14), fmt(p.coins)),
          h("span", { class: "apple" }, fmt(p.apples), " ", t("apples")))));
  }
  run();
}

export async function renderPlayer(root, id) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  const res = await api.get("admin-players?id=" + encodeURIComponent(id));
  if (!res.ok) { clear(root).append(h("a", { class: "btn ghost", href: "#/players" }, icon("back"), t("back")), h("div", { class: "empty" }, res.data.error || t("networkError"))); return; }
  show(res.data);

  function show(data) {
    const { player, state, events, matchTotals = [], matches = [] } = data;
    clear(root);
    root.append(
      h("div", { class: "toolbar" },
        h("a", { class: "btn ghost", href: "#/players" }, icon("back"), t("back")),
        h("h2", { class: "grow title-sm" }, player.display_name || player.email || player.id)),
      h("div", { class: "panel" },
        h("div", { class: "kv" }, h("span", {}, t("email")), h("span", { dir: "ltr" }, player.email || "—")),
        h("div", { class: "kv" }, h("span", {}, t("signIn")), h("span", {}, signInName({ ...player, providers: (player.providers || []).join(",") }))),
        h("div", { class: "kv" }, h("span", {}, t("joined")), h("span", {}, new Date(player.created_at).toLocaleDateString("he-IL"))),
        h("div", { class: "kv" }, h("span", {}, t("lastSeen")), h("span", { title: player.last_seen_at ? new Date(player.last_seen_at).toLocaleString("he-IL") : "" }, player.last_seen_at ? ago(player.last_seen_at) : t("notSeenYet"))),
        h("div", { class: "kv" }, h("span", {}, t("appBuild")), h("span", { dir: "ltr" }, buildName(player.last_client) || "—")),
        h("div", { class: "kv" }, h("span", {}, t("playerCode")),
          h("button", { type: "button", class: "btn ghost small", dir: "ltr", onclick: () => { navigator.clipboard?.writeText(playerCode(player.id)); toast(t("copied")); } },
            icon("copy", 14), playerCode(player.id))),
        h("div", { class: "kv" }, h("span", {}, t("id")),
          h("button", { type: "button", class: "btn ghost small", dir: "ltr", onclick: () => { navigator.clipboard?.writeText(player.id); toast(t("copied")); } },
            icon("copy", 14), player.id.slice(0, 8) + "…"))),
      h("div", { class: "stat-row" },
        bigStat(t("coins"), fmt(state.coins), "#ffd04d"),
        bigStat(t("apples"), fmt(state.apples), "#ffb547"),
        ...rules.rarities.map(r => bigStat(`${t("shards")} · ${rarityName(r.id)}`, fmt(state.shards[r.id]), RARITY_COLORS[r.id]))),
      activityPanel(matchTotals, matches),
      grantPanel(player.id, show),
      collectionPanel(state),
      historyPanel(events));
  }
}

const bigStat = (label, value, color) => h("div", { class: "big-stat", style: { "--c": color } }, h("div", { class: "big-value" }, value), h("div", { class: "muted small" }, label));

// ------------------------------------------------------------------ activity

function activityPanel(totals, matches) {
  const count = (mode, result) => totals.filter(x => (!mode || x.mode === mode) && (!result || x.result === result)).reduce((n, x) => n + x.n, 0);
  const modes = ["ai", "online", "tutorial"].filter(m => count(m) > 0);
  return h("section", { class: "panel" },
    h("h3", { class: "section" }, t("activity"), " ", h("span", { class: "muted small" }, t("gamesCount", count(), count(null, "win")))),
    modes.length === 0 ? h("div", { class: "muted" }, t("noGames")) : [
      h("div", { class: "mode-grid" }, modes.map(m => h("div", { class: "kv" }, h("span", {}, t("mode." + m)),
        h("span", {}, t("winLose", count(m, "win"), count(m) - count(m, "win")))))),
      h("div", { class: "history" }, matches.map(m => h("div", { class: "history-row" },
        h("span", { class: "badge" + (m.result === "win" ? "" : " lose") }, t("result." + m.result) === "result." + m.result ? m.result : t("result." + m.result)),
        h("span", { class: "grow small" }, t("mode." + m.mode) === "mode." + m.mode ? m.mode : t("mode." + m.mode), m.turns ? " · " + t("turns", m.turns) : ""),
        h("span", { class: "muted small" }, new Date(m.created_at).toLocaleString("he-IL")))))]);
}

// ------------------------------------------------------------------ grant

function grantPanel(userId, onResult) {
  const inputs = {};
  const numInput = key => (inputs[key] = h("input", { class: "input num", type: "number", inputmode: "numeric", value: "", placeholder: "0" }));
  const cardRows = h("div", { class: "grant-cards" });
  const cards = allCards().slice().sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  function addCardRow() {
    const select = h("select", { class: "input grow" }, h("option", { value: "" }, t("pickCard")),
      cards.map(c => h("option", { value: c.id }, `${c.name || c.id} (${c.id})`)));
    const qty = h("input", { class: "input num", type: "number", inputmode: "numeric", value: "1" });
    const row = h("div", { class: "grant-card-row" }, select, qty, h("span", { class: "muted small" }, t("copies")),
      h("button", { type: "button", class: "btn ghost sq", onclick: () => row.remove(), "aria-label": "remove" }, icon("close")));
    cardRows.append(row);
  }

  const note = h("input", { class: "input", placeholder: t("note") });
  const go = h("button", { type: "button", class: "btn primary" }, t("grant"));
  go.addEventListener("click", async () => {
    const n = key => Math.trunc(Number(inputs[key]?.value) || 0);
    const body = { action: "grant", userId, coins: n("coins"), apples: n("apples"), cards: {}, shards: {}, note: note.value };
    for (const r of rules.rarities) if (n("shard_" + r.id)) body.shards[r.id] = n("shard_" + r.id);
    for (const row of cardRows.children) {
      const [sel, qty] = row.querySelectorAll("select, input");
      const q = Math.trunc(Number(qty.value) || 0);
      if (sel.value && q) body.cards[sel.value] = (body.cards[sel.value] || 0) + q;
    }
    const parts = [];
    const sign = v => (v > 0 ? "+" : "") + fmt(v);
    if (body.coins) parts.push(`${sign(body.coins)} ${t("coins")}`);
    if (body.apples) parts.push(`${sign(body.apples)} ${t("apples")}`);
    for (const [r, v] of Object.entries(body.shards)) parts.push(`${sign(v)} ${t("shards")} ${rarityName(r)}`);
    for (const [c, v] of Object.entries(body.cards)) parts.push(`${sign(v)} × ${cards.find(x => x.id === c)?.name || c}`);
    if (parts.length === 0) { toast(t("nothingToGrant"), "error"); return; }
    if (!confirm(t("confirmGrant", parts.join(", ")))) return;
    go.disabled = true;
    go.textContent = t("granting");
    const res = await api.post("admin-players", body);
    go.disabled = false;
    go.textContent = t("grant");
    if (!res.ok) { toast(`${t("grantFailed")} (${res.data.error || res.status})`, "error"); return; }
    toast(t("grantDone"));
    onResult(res.data);
  });

  return h("section", { class: "panel" },
    h("h3", { class: "section" }, t("grantTitle")),
    h("div", { class: "hint" }, t("grantHint")),
    h("div", { class: "row2" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("coins")), numInput("coins")),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("apples")), numInput("apples"))),
    h("div", { class: "row5" }, rules.rarities.map(r => h("label", { class: "field" },
      h("span", { class: "field-label", style: { color: RARITY_COLORS[r.id] } }, `${t("shards")} ${rarityName(r.id)}`), numInput("shard_" + r.id)))),
    h("div", { class: "field-label" }, t("cards")),
    cardRows,
    h("button", { type: "button", class: "btn ghost", onclick: addCardRow }, icon("plus"), t("addCardRow")),
    note,
    h("div", { class: "actions" }, go));
}

// ------------------------------------------------------------------ collection and history

function collectionPanel(state) {
  const grid = h("div", { class: "owned-grid" });
  const search = h("input", { type: "search", class: "input", placeholder: t("searchCollection"), oninput: () => fill() });
  const byId = Object.fromEntries(allCards().map(c => [c.id, c]));
  function fill() {
    clear(grid);
    const q = search.value.trim().toLowerCase();
    const owned = Object.entries(state.cards)
      .map(([id, o]) => ({ id, ...o, card: byId[id] }))
      .filter(x => !q || `${x.id} ${x.card?.name || ""}`.toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    for (const x of owned) {
      const max = x.card && kindOf(x.card) === "god" ? 1 : 4;
      grid.append(h("a", { class: "owned", href: `#/cards/${encodeURIComponent(x.id)}`, style: { "--rarity": RARITY_COLORS[x.card?.rarity || "bronze"] } },
        h("div", { class: "owned-art", style: { backgroundImage: x.card ? `url("${artUrl(x.card, 160)}")` : "none" } }),
        h("div", { class: "owned-name" }, x.card?.name || x.id),
        h("div", { class: "muted small" }, `${x.count}/${max}`, x.locked ? ` · ${t("locked")} ${x.locked}` : "")));
    }
  }
  fill();
  const total = Object.values(state.cards).reduce((s, o) => s + o.count, 0);
  return h("section", { class: "panel" },
    h("h3", { class: "section" }, t("collection"), " ", h("span", { class: "muted small" }, `${Object.keys(state.cards).length} · ${total} ${t("copies")}`)),
    search, grid);
}

function historyPanel(events) {
  return h("section", { class: "panel" },
    h("h3", { class: "section" }, t("history")),
    events.length === 0 ? h("div", { class: "muted" }, t("noHistory")) :
      h("div", { class: "history" }, events.map(e => h("div", { class: "history-row" },
        h("span", { class: "badge" }, t("event." + e.kind) === "event." + e.kind ? e.kind : t("event." + e.kind)),
        h("span", { class: "grow small", dir: "ltr" }, summarize(e)),
        h("span", { class: "muted small" }, new Date(e.created_at).toLocaleString("he-IL"))))));
}

function summarize(e) {
  const d = e.detail || {};
  const bits = [];
  if (d.coins) bits.push(`coins ${d.coins > 0 ? "+" : ""}${d.coins}`);
  if (d.apples) bits.push(`apples ${d.apples > 0 ? "+" : ""}${d.apples}`);
  if (d.pack) bits.push(`pack ${d.pack}`);
  if (d.cardId) bits.push(d.cardId);
  if (d.cards && typeof d.cards === "object" && !Array.isArray(d.cards)) bits.push(...Object.entries(d.cards).map(([k, v]) => `${k}×${v}`));
  if (d.shards && typeof d.shards === "object") bits.push(...Object.entries(d.shards).map(([k, v]) => `${k} shards ${v}`));
  if (d.note) bits.push(`“${d.note}”`);
  return bits.join(", ");
}
