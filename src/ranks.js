import { api } from "./api.js";
import { h, clear, icon, toast } from "./dom.js";
import { t } from "./i18n.js";

// Ranked play: how many players are in each league this season, the 10 leagues (names, points, the computer, rewards)
// and the general rules (cap, streak, mercy, seasons).
const PACKS = ["basic", "big", "premium"];

export async function renderRanks(root) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  const res = await api.get("ranked?admin=1");
  if (!res.ok) { clear(root).append(h("div", { class: "empty" }, t("networkError"))); return; }
  const { config, distribution } = res.data;
  clear(root);

  // ---- who is where
  const max = Math.max(1, ...distribution.leagues.map(l => l.players));
  const season = distribution.season;
  root.append(h("section", { class: "panel" },
    h("h2", {}, t("ranksDistribution")),
    h("p", { class: "hint" }, season.pre ? t("ranksPreSeason", date(season.endsAt)) : t("ranksSeason", season.number, date(season.endsAt)), " · ", t("ranksPlayers", distribution.players)),
    h("div", { class: "rank-bars" }, distribution.leagues.map(l => h("div", { class: "rank-bar-row" },
      h("span", { class: "rank-bar-name" }, `${l.league}. ${l.he}`),
      h("span", { class: "rank-bar-track" }, h("span", { class: "rank-bar-fill", style: { width: `${(l.players / max) * 100}%` } })),
      h("span", { class: "rank-bar-n" }, String(l.players)))))));

  // ---- the leagues
  const num = (v, attrs = {}) => h("input", { class: "input num", type: "number", step: "1", dir: "ltr", value: v ?? 0, ...attrs });
  const box = v => h("input", { type: "checkbox", checked: !!v });
  const bundleInputs = b => ({ coins: num(b?.coins || 0, { min: "0" }), apples: num(b?.apples || 0, { min: "0" }), ...Object.fromEntries(PACKS.map(p => [p, num(b?.packs?.[p] || 0, { min: "0", max: "10" })])) });
  const bundleCell = inputs => h("div", { class: "bundle" },
    h("label", {}, h("span", { class: "muted small" }, t("ranksCoins")), inputs.coins),
    h("label", {}, h("span", { class: "muted small" }, t("ranksApples")), inputs.apples),
    PACKS.map(p => h("label", {}, h("span", { class: "muted small" }, t("pack." + p)), inputs[p])));
  const readBundle = inputs => ({ coins: +inputs.coins.value || 0, apples: +inputs.apples.value || 0, packs: Object.fromEntries(PACKS.map(p => [p, +inputs[p].value || 0])) });

  const rows = config.leagues.map(l => {
    const f = {
      he: h("input", { class: "input", value: l.he }), en: h("input", { class: "input", dir: "ltr", value: l.en }),
      min: num(l.min, { min: "0", disabled: l.league === 1 }), win: num(l.win, { min: "0" }), loss: num(l.loss, { min: "0" }),
      floor: box(l.floor), streak: box(l.streak), aiPercent: num(l.aiPercent, { min: "0", max: "100" }), aiLevel: num(l.aiLevel, { min: "1", max: "10" }),
      reward: bundleInputs(l.reward), seasonReward: bundleInputs(l.seasonReward)
    };
    return { league: l.league, f, el: [
      h("tr", { class: "rank-row" },
        h("td", { rowspan: "2" }, h("b", {}, String(l.league))),
        h("td", {}, f.he, f.en),
        h("td", {}, f.min),
        h("td", {}, f.win),
        h("td", {}, f.loss),
        h("td", {}, h("label", { class: "check" }, f.floor, t("ranksFloor")), h("label", { class: "check" }, f.streak, t("ranksStreak"))),
        h("td", {}, f.aiPercent),
        h("td", {}, f.aiLevel)),
      h("tr", { class: "rank-rewards" },
        h("td", { colspan: "7" },
          h("div", { class: "reward-pair" },
            h("div", {}, h("div", { class: "muted small" }, t("ranksLeagueReward")), bundleCell(f.reward)),
            h("div", {}, h("div", { class: "muted small" }, t("ranksSeasonReward")), bundleCell(f.seasonReward)))))
    ] };
  });

  const g = {
    cap: num(config.cap, { min: "100" }), streakFrom: num(config.streakFrom, { min: "2" }), streakBonus: num(config.streakBonus, { min: "0" }),
    mercyAfter: num(config.mercyAfter, { min: "0" }), minTurns: num(config.minTurns, { min: "0" }), openMinutes: num(config.openMinutes, { min: "10" }),
    seasonMonths: num(config.seasonMonths, { min: "1", max: "12" }), firstSeasonStart: h("input", { class: "input", type: "date", dir: "ltr", value: config.firstSeasonStart }),
    resetFrom: num(config.resetFrom, { min: "0" }), resetKeepPercent: num(config.resetKeepPercent, { min: "0", max: "100" })
  };
  const field = (key, input) => h("label", { class: "field" }, h("span", { class: "field-label" }, t("ranksField." + key)), input);

  const save = h("button", { type: "button", class: "btn primary", onclick: async () => {
    const cfg = {
      ...Object.fromEntries(Object.entries(g).map(([k, el]) => [k, k === "firstSeasonStart" ? el.value : Number(el.value)])),
      leagues: rows.map(({ league, f }) => ({
        league, he: f.he.value, en: f.en.value, min: Number(f.min.value), win: Number(f.win.value), loss: Number(f.loss.value),
        floor: f.floor.checked, streak: f.streak.checked, aiPercent: Number(f.aiPercent.value), aiLevel: Number(f.aiLevel.value),
        reward: readBundle(f.reward), seasonReward: readBundle(f.seasonReward)
      }))
    };
    if (!/^\d{4}-\d{2}-01$/.test(cfg.firstSeasonStart)) { toast(t("ranksFirstOfMonth"), "error"); return; }
    // An emptied number field reads as 0 and the server would quietly "fix" it (league 2 once started at 1).
    const inputs = [...Object.values(g), ...rows.flatMap(({ f }) => [f.min, f.win, f.loss, f.aiPercent, f.aiLevel,
      ...Object.values(f.reward), ...Object.values(f.seasonReward)])].filter(el => el.type === "number" && !el.disabled);
    const empty = inputs.find(el => el.value.trim() === "" || !Number.isInteger(Number(el.value)));
    if (empty) { empty.focus(); toast(t("ranksEmptyField"), "error"); return; }
    for (let i = 1, previous = 0; i < rows.length; i++) {
      const min = Number(rows[i].f.min.value);
      if (min <= previous) { rows[i].f.min.focus(); toast(t("ranksStartOrder", rows[i].league, previous), "error"); return; }
      previous = min;
    }
    save.disabled = true;
    const r = await api.post("ranked", { action: "saveConfig", config: cfg });
    save.disabled = false;
    if (!r.ok) { toast(r.data.message || t("networkError"), "error"); return; }
    toast(t("settingsSaved"));
    renderRanks(root);
  } }, icon("save"), t("save"));

  root.append(
    h("section", { class: "panel" },
      h("h2", {}, t("ranksLeaguesTitle")),
      h("p", { class: "hint" }, t("ranksLeaguesHint")),
      h("div", { class: "table-wrap" }, h("table", { class: "ranks-table" },
        h("thead", {}, h("tr", {}, ["#", t("ranksName"), t("ranksMin"), t("ranksWin"), t("ranksLoss"), t("ranksRules"), t("ranksAiPercent"), t("ranksAiLevel")].map(x => h("th", {}, x)))),
        h("tbody", {}, rows.flatMap(r => r.el))))),
    h("section", { class: "panel" },
      h("h2", {}, t("ranksGeneral")),
      h("p", { class: "hint" }, t("ranksGeneralHint")),
      h("div", { class: "grid-fields" }, Object.entries(g).map(([k, el]) => field(k, el))),
      h("div", { class: "toolbar" }, save)));
}

function date(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric" });
}

/** The player page's ranked panel: league, points, recent ranked games, a manual correction and the nickname reset. */
export function rankPanel(userId, rank, nickname, leagues, onChange) {
  const name = n => leagues?.find(l => l.league === n)?.he || String(n);
  const points = h("input", { class: "input num", type: "number", min: "0", dir: "ltr", value: rank?.points ?? 0 });
  const note = h("input", { class: "input", placeholder: t("note") });
  const set = h("button", { type: "button", class: "btn", onclick: async () => {
    set.disabled = true;
    const r = await api.post("ranked", { action: "adjust", userId, points: Number(points.value), note: note.value });
    set.disabled = false;
    if (!r.ok) { toast(r.data.message || t("networkError"), "error"); return; }
    toast(t("ranksAdjusted", r.data.before, r.data.after));
    onChange();
  } }, t("ranksSetPoints"));
  const reset = h("button", { type: "button", class: "btn ghost", onclick: async () => {
    if (!confirm(t("ranksResetNickConfirm"))) return;
    const r = await api.post("ranked", { action: "resetNickname", userId });
    if (!r.ok) { toast(r.data.message || t("networkError"), "error"); return; }
    toast(t("ranksNickReset", r.data.nickname));
    onChange();
  } }, t("ranksResetNick"));

  return h("section", { class: "panel" },
    h("h2", {}, t("ranksPlayerTitle")),
    h("div", { class: "kv" }, h("span", {}, t("ranksNickname")), h("span", {}, nickname || t("ranksNoNick"), " ", nickname ? reset : null)),
    rank ? [
      h("div", { class: "kv" }, h("span", {}, t("ranksLeague")), h("span", {}, `${rank.league}. ${name(rank.league)} · ${rank.points} ${t("ranksPoints")}`)),
      h("div", { class: "kv" }, h("span", {}, t("ranksBest")), h("span", {}, `${rank.best}. ${name(rank.best)}`)),
      h("div", { class: "kv" }, h("span", {}, t("ranksGames")), h("span", {}, t("winLose", rank.wins, rank.games - rank.wins))),
    ] : h("div", { class: "kv" }, h("span", {}, t("ranksLeague")), h("span", { class: "muted" }, t("ranksNotPlayed"))),
    rank?.matches?.length ? h("table", { class: "mini" }, h("tbody", {}, rank.matches.map(m => h("tr", {},
      h("td", {}, new Date(m.started_at).toLocaleString("he-IL")),
      h("td", {}, t("rankResult." + (m.result || "open"))),
      h("td", { dir: "ltr" }, m.delta == null ? "" : (m.delta > 0 ? "+" : "") + m.delta),
      h("td", { class: "muted" }, m.ai_level ? t("aiLevel", m.ai_level) : ""))))) : null,
    h("div", { class: "toolbar" }, h("span", { class: "muted small" }, t("ranksSetHint")), points, note, set));
}
