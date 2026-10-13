// Calls to the Netlify functions; the session is the HttpOnly cookie of the same site.
const BASE = "/.netlify/functions/";

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, data: { error: "network" } };
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

export const api = {
  get: path => request("GET", path),
  post: (path, body) => request("POST", path, body),
};
