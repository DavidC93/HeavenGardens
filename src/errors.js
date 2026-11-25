import { api } from "./api.js";
import { h, clear, icon, toast } from "./dom.js";
import { t } from "./i18n.js";

// Errors the game reported from players' phones, the same error grouped: how often, for how many players, in which
// versions, and the newest stack trace. Hard native crashes are in Play Console (Android vitals), not here.
let days = 7;
let version = "";

const when = d => new Date(d).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });

export async function renderErrors(root) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  const res = await api.get(`admin-errors?days=${days}${version ? `&version=${encodeURIComponent(version)}` : ""}`);
  if (!res.ok) { clear(root).append(h("div", { class: "empty" }, t("networkError"))); return; }
  const { totals, groups, versions } = res.data;
  clear(root);

  const periods = h("div", { class: "toolbar wrap" },
    ...[1, 7, 30, 90].map(d => h("button", {
      type: "button", class: `btn ${days === d ? "primary" : "ghost"}`,
      onclick: () => { days = d; renderErrors(root); }
    }, t("errors.days", d))),
    h("div", { class: "grow" }),
    h("select", { class: "input", onchange: e => { version = e.target.value; renderErrors(root); } },
      h("option", { value: "" }, t("errors.allVersions")),
      ...versions.map(v => {
        const o = h("option", { value: v.version }, `${v.version} (${v.total})`);
        if (v.version === version) o.selected = true;
        return o;
      })));

  root.append(
    h("section", { class: "panel" },
      h("h2", {}, t("errorsTitle")),
      h("p", { class: "hint" }, t("errorsHint")),
      periods,
      h("div", { class: "ai-summary" },
        h("span", {}, t("errors.total", totals.total)),
        h("span", {}, t("errors.kinds", groups.length)),
        h("span", {}, t("errors.players", totals.players)))));

  if (!groups.length) { root.append(h("div", { class: "empty" }, t("errorsEmpty"))); return; }
  root.append(h("div", { class: "support-list" }, groups.map(errorCard)));
}

function errorCard(g) {
  const stack = g.stack || "";
  return h("article", { class: "panel support-card" },
    h("div", { class: "support-head" },
      h("span", { class: `badge ${g.kind === "exception" ? "lose" : "unknown"}` }, g.kind),
      h("b", { class: "grow" }, " ", t("errors.times", g.total)),
      h("span", { class: "muted small" }, t("errors.reach", g.players, g.reports))),
    // message and stack are text nodes: whatever a device sent is shown as letters, never run
    h("p", { class: "support-message", dir: "ltr" }, g.message),
    g.top ? h("div", { class: "muted small", dir: "ltr" }, g.top) : null,
    h("div", { class: "support-meta muted small" },
      h("span", {}, t("errors.last"), " ", h("span", { dir: "ltr" }, when(g.last_seen))),
      h("span", {}, " · ", t("errors.first"), " ", h("span", { dir: "ltr" }, when(g.first_seen))),
      g.versions?.length ? h("span", {}, " · ", t("errors.versions"), " ", h("span", { dir: "ltr" }, g.versions.join(", "))) : null,
      g.device ? h("span", {}, " · ", h("span", { dir: "ltr" }, g.device)) : null),
    stack ? h("details", { class: "error-stack" },
      h("summary", {}, t("errors.stack")),
      h("pre", { dir: "ltr" }, stack),
      h("button", { type: "button", class: "btn ghost", onclick: () => { navigator.clipboard?.writeText(`${g.message}\n${stack}`); toast(t("copied")); } },
        icon("copy"), t("errors.copy"))) : null);
}
