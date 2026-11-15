// Loads mempool.space's public frontend in headless Chromium with its API and WebSocket answered by
// our server, and reports what each page asks for, what fails and what errors it logs
// (docs/COMPAT.md, "mempool.space's frontend on this server"). Black box: only the network traffic
// and the rendered page are read, never the frontend's code. Only GET requests reach a backend;
// anything else is answered 404 here. A manual tool, not a CI job. Run from web/, so Playwright
// resolves:
//
//   cd web && node ../dev/compat/probe.mjs ORIGIN OUT [--control] [--only home,block]
//     [--network signet] [--node PUBKEY]
//
// ORIGIN is our server's origin, e.g. http://127.0.0.1:PORT; the sample block, transaction,
// address and Lightning node (the best connected, unless --node) are taken from it, on mainnet or
// --network. --control leaves mempool.space's own backend in
// place, for comparison. Writes OUT/report.json and a screenshot per page; prints a summary.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { chromium } = createRequire(join(process.cwd(), "package.json"))("playwright");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};
const [origin, out] = args;
if (!origin || !out || origin.startsWith("--")) {
  console.error(
    "usage: node ../dev/compat/probe.mjs ORIGIN OUT [--control] [--only a,b] [--network n] [--node k]",
  );
  process.exit(2);
}
const ours = origin.replace(/\/$/, "");
const control = args.includes("--control");
const only = flag("only")?.split(",");
const REF = "https://mempool.space";
const net = flag("network") ? `/${flag("network")}` : "";

const get = async (path) => {
  const r = await fetch(ours + net + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
};

const height = Number(await get("/api/blocks/tip/height")) - 2;
const hash = await get(`/api/block-height/${height}`);
const txid = (await get(`/api/block/${hash}/txids`))[5];
const tx = await get(`/api/tx/${txid}`);
const address = tx.vout.map((o) => o.scriptpubkey_address).find(Boolean);
const unconfirmed = (await get("/api/mempool/recent"))[0].txid;
const node =
  flag("node") ??
  (await get("/api/v1/lightning/nodes/rankings/connectivity").catch(() => []))[0]?.publicKey;
/** name, path, how long to watch it (ms) */
const pages = [
  ["home", "/", 25000],
  ["block", `/block/${hash}`],
  ["tx", `/tx/${txid}`],
  ["tx-unconfirmed", `/tx/${unconfirmed}`],
  ["address", `/address/${address}`],
  ["mempool-block", "/mempool-block/0"],
  ["blocks", "/blocks"],
  ["mining", "/mining"],
  ["graphs-mempool", "/graphs/mempool"],
  ["rbf", "/rbf"],
  ["lightning", "/lightning"],
  ...(node ? [["lightning-node", `/lightning/node/${node}`]] : []),
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const report = {
  control,
  sample: { network: net || "mainnet", height, hash, txid, address, unconfirmed, node },
  pages: {},
};

for (const [name, path, wait = 15000] of pages) {
  if (only && !only.includes(name)) continue;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const rec = { requests: [], sent: [], received: {}, errors: [] };
  report.pages[name] = rec;
  page.on("pageerror", (e) => rec.errors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error") rec.errors.push(`console: ${m.text().slice(0, 300)}`);
  });

  await page.route(`${REF}${net}/api/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const row = { method: req.method(), path: u.pathname + u.search };
    rec.requests.push(row);
    try {
      // Never a write, to either backend.
      if (req.method() !== "GET") {
        row.status = "not forwarded";
        return await route.fulfill({ status: 404, body: "" });
      }
      if (control) {
        const r = await route.fetch();
        row.status = r.status();
        return await route.fulfill({ response: r });
      }
      const r = await route.fetch({
        url: ours + row.path,
        headers: { accept: req.headers().accept ?? "*/*" },
      });
      row.status = r.status();
      await route.fulfill({ response: r });
    } catch (e) {
      row.status = `error: ${String(e.message).slice(0, 120)}`;
      await route.abort().catch(() => {});
    }
  });

  // Each page's upstream sockets close with the page: our server allows a client four.
  const ups = [];
  page.on("close", () => ups.forEach((u) => u.close()));
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    const up = new WebSocket(control ? ws.url() : `${ours.replace(/^http/, "ws")}${net}/api/v1/ws`);
    ups.push(up);
    const queue = [];
    up.onopen = () => queue.splice(0).forEach((m) => up.send(m));
    up.onmessage = (e) => {
      try {
        for (const k of Object.keys(JSON.parse(e.data))) {
          rec.received[k] = (rec.received[k] ?? 0) + 1;
        }
      } catch {
        rec.received["(not json)"] = (rec.received["(not json)"] ?? 0) + 1;
      }
      ws.send(e.data);
    };
    up.onclose = () => ws.close();
    ws.onMessage((m) => {
      rec.sent.push(String(m).slice(0, 200));
      if (up.readyState === WebSocket.OPEN) up.send(m);
      else queue.push(m);
    });
    ws.onClose(() => up.close());
  });

  try {
    await page.goto(REF + net + path, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(wait);
    await page.screenshot({ path: join(out, `${name}.png`) });
  } catch (e) {
    rec.errors.push(`probe: ${String(e.message).slice(0, 300)}`);
  }
  await context.close();
  ups.forEach((u) => u.close());
}
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));

// The summary: per page, the requests that failed, the socket traffic and the errors, with
// hashes, addresses and heights folded so that repeats count together.
const norm = (s) =>
  s
    .replace(/[0-9a-f]{64}/g, ":hash")
    .replace(/(bc1|[13])[a-zA-Z0-9]{25,62}/g, ":addr")
    .replace(/\/\d{6,}/g, "/:n");
const count = (list) => {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
};
console.log("sample", JSON.stringify(report.sample));
for (const [name, p] of Object.entries(report.pages)) {
  const ok = p.requests.filter((q) => q.status === 200).length;
  console.log(`\n== ${name}: ${p.requests.length} api requests, ${ok} answered 200`);
  const bad = p.requests.filter((q) => q.status !== 200);
  for (const [k, n] of count(bad.map((q) => `${q.status} ${q.method} ${norm(q.path)}`))) {
    console.log("  fail", n, k);
  }
  console.log("  ws sent:", [...new Set(p.sent.map(norm))].join(" | "));
  console.log("  ws received:", JSON.stringify(p.received));
  for (const [k, n] of count(p.errors.map((e) => norm(e).slice(0, 160)))) {
    console.log("  err", n, k);
  }
}
process.exit(0);
