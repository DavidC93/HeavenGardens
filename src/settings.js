import { api } from "./api.js";
import { h, clear, icon, toast } from "./dom.js";
import { t } from "./i18n.js";

// App versions: the oldest Android build that may still play (older ones must update) and the build players are
// invited to update to. Build numbers are the versionCode shown in Play Console for each release.
export async function renderSettings(root) {
  clear(root).append(h("div", { class: "muted" }, t("loading")));
  const res = await api.get("app-status");
  if (!res.ok) { clear(root).append(h("div", { class: "empty" }, t("networkError"))); return; }
  const v = res.data.versions?.android || { min: 0, recommended: 0 };
  const min = h("input", { class: "input", type: "number", min: "0", step: "1", dir: "ltr", value: String(v.min) });
  const recommended = h("input", { class: "input", type: "number", min: "0", step: "1", dir: "ltr", value: String(v.recommended) });
  const save = h("button", { type: "button", class: "btn primary", onclick: async () => {
    const minN = Math.max(0, Math.trunc(Number(min.value) || 0));
    const recN = Math.max(minN, Math.trunc(Number(recommended.value) || 0));
    if (minN > v.min && !confirm(t("minVersionConfirm", minN))) return;
    save.disabled = true;
    const out = await api.post("app-status", { versions: { android: { min: minN, recommended: recN } } });
    save.disabled = false;
    if (!out.ok) { toast(out.data.error || t("networkError"), "error"); return; }
    Object.assign(v, out.data.versions.android);
    min.value = String(v.min);
    recommended.value = String(v.recommended);
    toast(t("settingsSaved"));
  } }, icon("save"), t("save"));
  clear(root).append(
    h("section", { class: "panel" },
      h("h2", {}, t("versionsTitle")),
      h("p", { class: "hint" }, t("versionsHint")),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("minVersion")), min, h("span", { class: "hint" }, t("minVersionHint"))),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("recommendedVersion")), recommended, h("span", { class: "hint" }, t("recommendedVersionHint"))),
      h("div", { class: "toolbar" }, save)));
}
