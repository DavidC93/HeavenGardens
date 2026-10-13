// Local test server for the back office: serves the built site (dist/) and runs the Netlify functions in-process.
// Use a TEST database branch, never production:
//   npm run build && DATABASE_URL=<test branch> node scripts/dev-server.mjs   ->  http://localhost:8888
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 8888);
const root = process.cwd();
const dist = path.join(root, "dist");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
process.env.CONTEXT = "dev";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/.netlify/functions/")) {
      const name = url.pathname.split("/")[3];
      if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404).end(); return; }
      const mod = await import(pathToFileURL(path.join(root, "netlify/functions", name + ".mjs")).href);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const out = await mod.handler({
        httpMethod: req.method, headers: { ...req.headers, "x-nf-client-connection-ip": "127.0.0.1" },
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : null,
        queryStringParameters: Object.fromEntries(url.searchParams), rawQuery: url.search.slice(1), rawUrl: url.href,
      });
      // local http: drop "Secure" so the browser keeps the session cookie
      const headers = { ...(out.headers || {}) };
      if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].replace(/;\s*Secure/i, "");
      res.writeHead(out.statusCode, headers).end(out.body);
      return;
    }
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    try { if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html"); }
    catch { file = path.join(dist, "index.html"); }
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }).end(data);
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e.message));
  }
});
server.listen(PORT, () => console.log(`back office: http://localhost:${PORT}`));
