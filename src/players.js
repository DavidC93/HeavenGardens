import { rankPanel } from "./ranks.js";
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

/** One color per league (1 = Arcadia … 10 = Heaven Gardens), for the shield chips. */
const LEAGUE_COLORS = ["#a3a3b8", "#5eead4", "#facc15", "#86efac", "#f0abfc", "#93c5fd", "#fca5a5", "#c4b5fd", "#fdba74", "#ffd27a"];
export const leagueColor = n => LEAGUE_COLORS[Math.max(0, Math.min(9, (n || 1) - 1))];
const usd = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "3 · El Dorado / 520 points" chip; muted "not ranked yet" without a rank. */
function leagueChip(rank, big = false) {
  if (!rank) return h("div", { class: "league-chip none" + (big ? " big" : "") }, h("span", { class: "league-shield" }, icon("shield", big ? 22 : 16)),
    h("div", {}, h("div", { class: "league-name" }, t("ranksNotRanked")), h("div", { class: "league-pts" }, "—")));
  return h("div", { class: "league-chip" + (big ? " big" : ""), style: { "--lc": leagueColor(rank.league) }, title: `${t("ranksLeague")} ${rank.league}` },
    h("span", { class: "league-shield" }, h("b", {}, String(rank.league))),
    h("div", { class: "league-text" },
      h("div", { class: "league-name" }, rank.he || `${t("ranksLeague")} ${rank.league}`),
      h("div", { class: "league-pts" }, t("seasonPoints", fmt(rank.points)))));
}

const initial = p => String(p.display_name || p.nickname || p.email || "?").trim().charAt(0).toUpperCase() || "?";

let lastLeague = "";

export function renderPlayerList(root) {
  clear(root);
  const stats = h("div", { class: "stat-row" });
  const list = h("div", { class: "player-list" });
  const count = h("div", { class: "muted small list-count" });
  const search = h("input", { type: "search", class: "input", placeholder: t("searchPlayers"), value: lastQuery });
  const sort = h("select", { class: "input", "aria-label": t("sortBy"), onchange: () => { lastSort = sort.value; run(); } },
    ["recent", "new", "games", "points", "spent"].map(v => h("option", { value: v, selected: v === lastSort }, t("sort." + v))));
  const league = h("select", { class: "input", "aria-label": t("ranksLeague"), onchange: () => { lastLeague = league.value; fill(); } },
    h("option", { value: "" }, t("allLeagues")));
  let timer, data = null;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  root.append(
    h("div", { class: "toolbar wrap players-toolbar" }, h("div", { class: "search-box grow" }, icon("search"), search), h("div", { class: "toolbar-selects" }, league, sort)),
    stats, count, list, h("div", { class: "hint" }, t("playersHint")));

  async function run() {
    lastQuery = search.value.trim();
    list.replaceChildren(h("div", { class: "muted" }, t("loading")));
    const res = await api.get(`admin-players?q=${encodeURIComponent(lastQuery)}&sort=${lastSort}`);
    if (!res.ok) { list.replaceChildren(h("div", { class: "empty" }, t("networkError"))); return; }
    data = res.data;
    const s = data.stats;
    if (s) stats.replaceChildren(
      bigStat(t("statTotal"), fmt(s.total), "#9db4ff"),
      bigStat(t("statDay"), fmt(s.day), "#4ade80"),
      bigStat(t("statWeek"), fmt(s.week), "#facc15"),
      bigStat(t("statPlayed"), fmt(s.played), "#c084fc"),
      bigStat(t("statNewWeek"), fmt(s.new_week), "#38bdf8"),
      bigStat(t("statPayers"), fmt(s.payers ?? 0), "#fb923c"),
      bigStat(t("statRevenue"), usd(s.revenue), "#34d399"));
    if (data.leagues && league.options.length === 1)
      league.append(...data.leagues.map(l => h("option", { value: String(l.league), selected: String(l.league) === lastLeague }, `${l.league} · ${l.he}`)),
        h("option", { value: "none", selected: lastLeague === "none" }, t("ranksNotRanked")));
    fill();
  }

  function fill() {
    if (!data) return;
    const shown = data.players.filter(p => !lastLeague || (lastLeague === "none" ? !p.rank : String(p.rank?.league) === lastLeague));
    count.textContent = t("playersShown", shown.length, data.players.length);
    if (shown.length === 0) { list.replaceChildren(h("div", { class: "empty" }, t("noPlayers"))); return; }
    list.replaceChildren(...shown.map(playerCard));
  }
  run();
}

function playerCard(p) {
  const fresh = freshness(p.last_active);
  const winRate = p.games ? Math.round((p.wins / p.games) * 100) : null;
  const nick = p.nickname && p.nickname !== p.display_name ? p.nickname : null;
  return h("a", { class: "pcard", href: `#/players/${p.id}` },
    h("div", { class: "pcard-id" },
      h("span", { class: "avatar " + fresh, title: p.last_active ? new Date(p.last_active).toLocaleString("he-IL") : t("neverSeen") }, initial(p)),
      h("div", { class: "grow" },
        h("div", { class: "pcard-name" },
          h("span", { class: "ellipsis" }, p.display_name || p.nickname || p.email || p.id),
          p.role === "admin" ? h("span", { class: "badge" }, t("roleAdmin")) : null,
          p.spent > 0 ? h("span", { class: "badge payer", title: t("purchasesCount", p.purchases) }, usd(p.spent)) : null),
        nick ? h("div", { class: "pcard-sub" }, t("nicknameShort"), " ", h("b", {}, nick)) : null,
        h("div", { class: "pcard-sub ellipsis", dir: "ltr" }, playerCode(p.id), p.email ? " · " + p.email : ""))),
    leagueChip(p.rank),
    h("div", { class: "pcard-facts" },
      fact(t("factWins"), p.games ? t("winsOf", fmt(p.wins), fmt(p.games), winRate) : t("noGamesShort")),
      fact(t("factActive"), ago(p.last_active), null, fresh),
      fact(t("factLogin"), signInName(p)),
      fact(t("factBuild"), buildName(p.last_client) || "—", null, "", "ltr")),
    h("div", { class: "pcard-wallet" },
      h("span", { class: "coin" }, icon("coin", 14), fmt(p.coins)),
      h("span", { class: "apple" }, icon("apple", 14), fmt(p.apples))));
}

const fact = (label, value, title, cls = "", dir) =>
  h("div", { class: "fact", title: title || undefined }, h("span", { class: "fact-label" }, label), h("span", { class: "fact-value " + cls, dir }, value));

export async function renderPlayer(root, id) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  const res = await api.get("admin-players?id=" + encodeURIComponent(id));
  if (!res.ok) { clear(root).append(h("a", { class: "btn ghost", href: "#/players" }, icon("back"), t("back")), h("div", { class: "empty" }, res.data.error || t("networkError"))); return; }
  show(res.data);

  function show(data) {
    const { player, state, events, matchTotals = [], matches = [] } = data;
    const leagueName = n => data.leagues?.find(l => l.league === n)?.he;
    const rank = data.rank ? { ...data.rank, he: leagueName(data.rank.league) } : null;
    const copyBtn = (text, label) => h("button", { type: "button", class: "btn ghost small", dir: "ltr", onclick: e => { e.preventDefault(); navigator.clipboard?.writeText(text); toast(t("copied")); } }, icon("copy", 14), label);
    clear(root);
    root.append(
      h("div", { class: "toolbar" }, h("a", { class: "btn ghost", href: "#/players" }, icon("back"), t("back"))),
      h("section", { class: "panel hero" },
        h("div", { class: "hero-top" },
          h("span", { class: "avatar big " + freshness(player.last_seen_at) }, initial(player)),
          h("div", { class: "grow" },
            h("h2", { class: "hero-name" }, h("span", { class: "ellipsis" }, player.display_name || player.email || player.id),
              player.role === "admin" ? h("span", { class: "badge" }, t("roleAdmin")) : null),
            player.nickname ? h("div", { class: "muted" }, t("nicknameShort"), " ", h("b", {}, player.nickname)) : null,
            h("div", { class: "hero-ids" }, copyBtn(playerCode(player.id), playerCode(player.id)), copyBtn(player.id, t("id") + " " + player.id.slice(0, 8) + "…"))),
          leagueChip(rank, true)),
        h("div", { class: "info-grid" },
          info(t("email"), player.email || "—", "ltr"),
          info(t("signIn"), signInName({ ...player, providers: (player.providers || []).join(",") })),
          info(t("joined"), new Date(player.created_at).toLocaleDateString("he-IL")),
          info(t("lastSeen"), player.last_seen_at ? ago(player.last_seen_at) : t("notSeenYet")),
          info(t("appBuild"), buildName(player.last_client) || "—", "ltr"),
          info(t("ranksBestShort"), rank ? `${rank.best} · ${leagueName(rank.best) || ""}` : "—"))),
      h("div", { class: "stat-row" },
        bigStat(t("coins"), fmt(state.coins), "#ffd04d"),
        bigStat(t("apples"), fmt(state.apples), "#ffb547"),
        bigStat(t("spentMoney"), usd(data.store?.total), "#34d399"),
        ...rules.rarities.map(r => bigStat(`${t("shards")} · ${rarityName(r.id)}`, fmt(state.shards[r.id]), RARITY_COLORS[r.id]))),
      purchasesPanel(data.store, data.spending),
      activityPanel(matchTotals, matches),
      rankPanel(player.id, data.rank, player.nickname, data.leagues, () => renderPlayer(root, id)),
      grantPanel(player.id, show),
      collectionPanel(state),
      historyPanel(events));
  }
}

const info = (label, value, dir) => h("div", { class: "info" }, h("div", { class: "info-label" }, label), h("div", { class: "info-value", dir }, value));

const bigStat = (label, value, color, note) => h("div", { class: "big-stat", style: { "--c": color } },
  h("div", { class: "big-value" }, value), h("div", { class: "muted small" }, label), note ? h("div", { class: "hint small" }, note) : null);

// ------------------------------------------------------------------ purchases and spending

function purchasesPanel(store, spending) {
  store = store || { purchases: [], total: 0, count: 0, tests: 0, apples: 0 };
  spending = spending || { packs: [], crafts: 0, deckSlots: { n: 0, apples: 0 }, coins: 0, apples: 0 };
  const status = p => p.test === false ? h("span", { class: "badge paid" }, t("purchasePaid")) : h("span", { class: "badge test" }, t("purchaseTest"));
  const cost = (coins, apples) => [coins ? `${fmt(coins)} ${t("coins")}` : null, apples ? `${fmt(apples)} ${t("apples")}` : null].filter(Boolean).join(" + ") || "—";
  return h("section", { class: "panel" },
    h("h3", { class: "section" }, t("purchasesTitle")),
    h("div", { class: "mini-stats" },
      miniStat(usd(store.total), t("purchasesTotal")),
      miniStat(fmt(store.count), t("purchasesReal")),
      miniStat(fmt(store.apples), t("applesBought")),
      store.tests ? miniStat(fmt(store.tests), t("purchasesTests")) : null,
),
    store.purchases.length === 0 ? h("div", { class: "muted" }, t("noPurchases")) :
      h("div", { class: "table-wrap" }, h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, t("colDate")), h("th", {}, t("colProduct")), h("th", {}, t("colPrice")), h("th", {}, t("colStatus")), h("th", { class: "hide-sm" }, t("colOrder")))),
        h("tbody", {}, store.purchases.map(p => h("tr", {},
          h("td", { class: "nowrap", dir: "ltr" }, new Date(p.created_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })),
          h("td", {}, t("applesN", fmt(p.apples))),
          h("td", { dir: "ltr", class: "nowrap" }, usd(p.usd)),
          h("td", {}, status(p)),
          h("td", { class: "hide-sm small muted", dir: "ltr" }, p.order_id || "—")))))),
    h("div", { class: "hint" }, t("purchasesHint")),
    h("h3", { class: "section" }, t("spendingTitle")),
    h("div", { class: "mini-stats" },
      miniStat(fmt(spending.coins), t("coinsSpent")),
      miniStat(fmt(spending.apples), t("applesSpent"))),
    h("div", { class: "spend-list" },
      spending.packs.map(p => h("div", { class: "spend-row" },
        h("span", { class: "grow" }, t("pack." + p.pack) === "pack." + p.pack ? p.pack : t("pack." + p.pack), " × ", h("b", {}, fmt(p.n))),
        h("span", { class: "muted small" }, cost(p.coins, p.apples)))),
      spending.deckSlots.n ? h("div", { class: "spend-row" }, h("span", { class: "grow" }, t("deckSlotsBought"), " × ", h("b", {}, fmt(spending.deckSlots.n))),
        h("span", { class: "muted small" }, cost(0, spending.deckSlots.apples))) : null,
      spending.crafts ? h("div", { class: "spend-row" }, h("span", { class: "grow" }, t("event.craft"), " × ", h("b", {}, fmt(spending.crafts))), h("span", { class: "muted small" }, t("shards"))) : null,
      !spending.packs.length && !spending.deckSlots.n && !spending.crafts ? h("div", { class: "muted" }, t("noSpending")) : null));
}

const miniStat = (value, label) => h("div", { class: "mini-stat" }, h("b", {}, value), h("span", { class: "muted small" }, label));

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
