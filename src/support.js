import { api } from "./api.js";
import { h, clear, icon, toast } from "./dom.js";
import { t } from "./i18n.js";

// Messages players sent from the game's help screen: open ones first, each with who sent it (their account when they
// were signed in), the app version and the device, and a button that marks it handled. Everything is shown as text.
let filter = "open";

export async function renderSupport(root) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  const res = await api.get(`admin-support?status=${filter}`);
  if (!res.ok) { clear(root).append(h("div", { class: "empty" }, t("networkError"))); return; }
  const { requests, counts } = res.data;
  clear(root);

  const tabs = h("div", { class: "toolbar" },
    ...["open", "done", "all"].map(f => h("button", {
      type: "button", class: `btn ${filter === f ? "primary" : "ghost"}`,
      onclick: () => { filter = f; renderSupport(root); }
    }, t("support." + f), f === "open" && counts.open ? h("span", { class: "badge payer" }, String(counts.open)) : null)));
  root.append(
    h("section", { class: "panel" },
      h("h2", {}, t("supportTitle")),
      h("p", { class: "hint" }, t("supportHint")),
      tabs));

  if (!requests.length) { root.append(h("div", { class: "empty" }, t("supportEmpty"))); return; }
  root.append(h("div", { class: "support-list" }, requests.map(r => card(r, () => renderSupport(root)))));
}

function card(r, refresh) {
  const done = r.status === "done";
  const toggle = h("button", { type: "button", class: `btn ${done ? "ghost" : "primary"}`, onclick: async () => {
    toggle.disabled = true;
    const res = await api.post("admin-support", { id: r.id, status: done ? "open" : "done" });
    toggle.disabled = false;
    if (!res.ok) { toast(res.data.message || t("networkError"), "error"); return; }
    refresh();
  } }, done ? t("support.reopen") : t("support.markDone"));

  const who = [
    h("b", {}, r.name),
    r.nickname ? h("span", { class: "muted" }, ` · ${r.nickname}`) : null,
    r.user_id ? h("a", { href: `#/players/${encodeURIComponent(r.user_id)}`, class: "small" }, ` · ${t("support.profile")}`) : h("span", { class: "muted small" }, ` · ${t("support.guest")}`),
  ];
  const reply = r.email || r.account_email;
  return h("article", { class: `panel support-card${done ? " done" : ""}` },
    h("div", { class: "support-head" },
      h("div", { class: "grow" }, who),
      h("span", { class: `badge ${done ? "paid" : "test"}` }, done ? t("support.done") : t("support.open"))),
    // the message is a text node: tags or scripts in it are shown as letters, never run
    h("p", { class: "support-message" }, r.message),
    h("div", { class: "support-meta muted small" },
      h("span", { dir: "ltr" }, new Date(r.created_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })),
      reply ? h("span", {}, " · ", h("span", { dir: "ltr" }, reply)) : h("span", {}, " · ", t("support.noEmail")),
      r.app_version ? h("span", {}, " · ", h("span", { dir: "ltr" }, `${r.platform || ""} ${r.app_version}`)) : null,
      r.device ? h("span", {}, " · ", h("span", { dir: "ltr" }, r.device)) : null,
      done && r.handled_by_email ? h("span", {}, " · ", t("support.handledBy"), " ", h("span", { dir: "ltr" }, r.handled_by_email)) : null),
    h("div", { class: "toolbar" },
      reply ? h("button", { type: "button", class: "btn ghost", onclick: () => { navigator.clipboard?.writeText(reply); toast(t("copied")); } }, icon("copy"), t("support.copyEmail")) : null,
      h("div", { class: "grow" }),
      toggle));
}
