import "./styles.css";
import { api } from "./api.js";
import { h, clear, icon, toast } from "./dom.js";
import { t } from "./i18n.js";
import { loadRules } from "./rules.js";
import { loadCards, renderCardList, renderCardEditor, isDirty, clearDirty } from "./cards.js";
import { renderPlayerList, renderPlayer } from "./players.js";
import { renderSettings } from "./settings.js";
import { renderAi, renderAiDeck } from "./ai.js";

// Heaven Gardens back office: cards (create / edit), players (currency, cards and shards), the computer's decks and levels, and app versions. Admins only.
const app = document.getElementById("app");
let me = null;
let view;

async function boot() {
  clear(app).append(h("div", { class: "center muted" }, t("loading")));
  const res = await api.get("auth-me");
  me = res.data?.user || null;
  if (!me || me.role !== "admin") { renderLogin(me && me.role !== "admin" ? t("notAdmin") : ""); return; }
  try {
    await Promise.all([loadRules(), loadCards()]);
  } catch {
    clear(app).append(h("div", { class: "center" }, t("networkError")));
    return;
  }
  renderShell();
  route();
}

function renderLogin(message) {
  const email = h("input", { class: "input", type: "email", autocomplete: "username", dir: "ltr", required: true });
  const password = h("input", { class: "input", type: "password", autocomplete: "current-password", dir: "ltr", required: true });
  const status = h("div", { class: "hint warn", role: "alert" }, message || "");
  const submit = h("button", { type: "submit", class: "btn primary" }, t("login"));
  const form = h("form", { class: "login panel", onsubmit: async e => {
    e.preventDefault();
    submit.disabled = true;
    const res = await api.post("auth-login", { email: email.value, password: password.value });
    submit.disabled = false;
    if (!res.ok) { status.textContent = res.status === 429 ? t("tooMany") : res.status === 0 ? t("networkError") : t("badLogin"); return; }
    if (res.data.user?.role !== "admin") { status.textContent = t("notAdmin"); return; }
    boot();
  } },
    h("h1", { class: "brand" }, t("appTitle")),
    h("p", { class: "muted" }, t("loginHint")),
    h("label", { class: "field" }, h("span", { class: "field-label" }, t("email")), email),
    h("label", { class: "field" }, h("span", { class: "field-label" }, t("password")), password),
    status, submit);
  clear(app).append(h("div", { class: "center" }, form));
  email.focus();
}

function renderShell() {
  view = h("main", { class: "view" });
  const nav = h("nav", { class: "tabs" },
    h("a", { href: "#/cards", "data-tab": "cards" }, icon("cards"), t("cards")),
    h("a", { href: "#/players", "data-tab": "players" }, icon("users"), t("players")),
    h("a", { href: "#/ai", "data-tab": "ai" }, icon("sword"), t("ai")),
    h("a", { href: "#/settings", "data-tab": "settings" }, icon("refresh"), t("settings")));
  clear(app).append(
    h("header", { class: "topbar" },
      h("div", { class: "brand" }, t("appTitle")),
      nav,
      h("div", { class: "me" },
        h("span", { class: "muted small", dir: "ltr" }, me.email || ""),
        h("button", { type: "button", class: "btn ghost sq", title: t("logout"), "aria-label": t("logout"), onclick: logout }, icon("logout")))),
    view);
}

async function logout() {
  await api.post("auth-logout");
  me = null;
  location.hash = "";
  boot();
}

let currentHash = location.hash;
function route() {
  if (!view) return;
  const hash = location.hash || "#/cards";
  const [, section, id] = hash.split("/");
  for (const a of document.querySelectorAll("[data-tab]")) a.classList.toggle("active", a.dataset.tab === (section || "cards"));
  window.scrollTo(0, 0);
  if (section === "settings") renderSettings(view);
  else if (section === "ai") id ? renderAiDeck(view, decodeURIComponent(id)) : renderAi(view);
  else if (section === "players") id ? renderPlayer(view, decodeURIComponent(id)) : renderPlayerList(view);
  else if (id) renderCardEditor(view, decodeURIComponent(id), savedId => { location.hash = `#/cards/${encodeURIComponent(savedId)}`; if (location.hash === currentHash) route(); });
  else renderCardList(view);
  currentHash = location.hash;
}

window.addEventListener("hashchange", () => {
  // leaving a card with unsaved changes
  if (isDirty() && !confirm(t("unsaved"))) {
    history.replaceState(null, "", currentHash);
    return;
  }
  clearDirty();
  route();
});
window.addEventListener("beforeunload", e => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });

boot().catch(() => toast(t("networkError"), "error"));
