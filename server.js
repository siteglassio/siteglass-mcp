#!/usr/bin/env node
// siteglass MCP server — exposes siteglass.io's web-QA loop as agent tools.
//
// An AI coding agent (Claude Code, Cursor, Claude Desktop, …) drives the
// whole loop over MCP: register the app it just built, prove ownership,
// scan it, derive + run E2E test flows, and read what broke.
//
// Tools return bounded (≤~50s) to stay under MCP client request timeouts:
// long ops (scan, run) return an id and you poll with siteglass_get_scan /
// siteglass_get_run.
//
// Config (env): SITEGLASS_BASE_URL (default https://siteglass.io),
//               SITEGLASS_API_KEY  (optional — auto-creates + caches one
//                                   at ~/.siteglass/key if absent).
//
// Run:  node server.js     (stdio transport — how MCP clients launch it)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = (process.env.SITEGLASS_BASE_URL || "https://siteglass.io").replace(/\/$/, "");
const KEY_FILE = path.join(os.homedir(), ".siteglass", "key");
const HERE = path.dirname(fileURLToPath(import.meta.url));

let KEY = process.env.SITEGLASS_API_KEY || null;
function loadKey() {
  if (KEY) return KEY;
  try { KEY = fs.readFileSync(KEY_FILE, "utf8").trim() || null; } catch {}
  return KEY;
}
async function ensureKey() {
  if (loadKey()) return KEY;
  const r = await fetch(`${BASE}/api/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  KEY = (await r.json()).api_key;
  try { fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true }); fs.writeFileSync(KEY_FILE, KEY, { mode: 0o600 }); } catch {}
  return KEY;
}
async function api(method, p, body) {
  await ensureKey();
  const r = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { ok: false, error: txt.slice(0, 200) }; }
  return j;
}
// Poll a status endpoint, but give up after maxMs so the tool call returns
// inside the client's request timeout. Returns the last response seen.
async function poll(p, { maxMs = 50000, ms = 2500 } = {}) {
  const deadline = Date.now() + maxMs;
  let last = await api("GET", p);
  while (Date.now() < deadline && last.ok && last.status !== "DONE" && last.status !== "ERROR") {
    await new Promise((res) => setTimeout(res, ms));
    last = await api("GET", p);
  }
  return last;
}
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

function scanSummary(j) {
  const f = (j.findings || []).map((x) => `  [${x.kind}/${x.severity}] ${x.title}`).join("\n");
  return `crawl_id: ${j.crawl_id}\n${j.page_count} pages (${j.discovered} discovered)\n\n` +
         `FINDINGS (${(j.findings || []).length}):\n${f}\n\nREPORT:\n${j.report_md || ""}\n\n` +
         `Next: siteglass_generate_flows with crawl_id=${j.crawl_id}.`;
}
function runSummary(j) {
  const steps = (j.steps || []).map((s) =>
    `  [${s.status}] ${s.action} — ${s.description}` + (s.error ? ` (${s.error})` : "") +
    (s.status === "repaired" ? ` [repaired: ${JSON.stringify(s.target)} -> ${s.repaired_to}]` : "")).join("\n");
  return `${j.passed}✓ ${j.failed}✗ ${j.skipped} skipped ${j.repaired} repaired\n${steps}\n\n` +
         `replay: ${BASE}${j.rrweb_url}\nvideo:  ${BASE}${j.video_url}`;
}

const server = new McpServer({ name: "siteglass", version: "0.2.0" });

server.tool(
  "siteglass_register_site",
  "Register a web app (its deployed URL) with siteglass and get an ownership-proof token to place on it. Step 1.",
  { url: z.string().describe("The app's URL, e.g. https://myapp.lovable.app") },
  async ({ url }) => {
    const j = await api("POST", "/api/sites", { domain: url });
    if (!j.ok) return text(`Error: ${j.error}`);
    const i = j.instructions || {};
    return text(`Registered. site_id: ${j.site_id}\n\nProve you control ${j.domain} with ANY ONE of:\n` +
      `• Meta tag (easiest for AI-built apps): ${i.meta_tag}\n• Hosted file: ${i.well_known}\n• DNS: ${i.dns_txt}\n\n` +
      `Add one (the meta tag goes in the homepage <head>), deploy, then call siteglass_verify_site with site_id=${j.site_id}.`);
  }
);

server.tool(
  "siteglass_verify_site",
  "Check that the ownership-proof token is live on the site. Step 2 (after placing the token).",
  { site_id: z.string() },
  async ({ site_id }) => {
    const j = await api("POST", `/api/sites/${site_id}/verify`);
    if (!j.ok) return text(`Error: ${j.error}`);
    return text(j.verified ? `Verified via ${j.method}. Now call siteglass_scan with site_id=${site_id}.`
                           : `Not verified yet — the token isn't reachable. Place it, redeploy, and retry.`);
  }
);

server.tool(
  "siteglass_scan",
  "Crawl a verified site (first scan per site is free). Returns a crawl_id; if still running, poll with siteglass_get_scan. Step 3.",
  { site_id: z.string() },
  async ({ site_id }) => {
    const start = await api("POST", `/api/sites/${site_id}/crawl`);
    if (!start.ok) return text(`Cannot scan: ${start.error}`);
    const j = await poll(`/api/crawls/${start.crawl_id}`);
    if (j.status === "DONE") return text(scanSummary(j));
    return text(`Scan started. crawl_id: ${start.crawl_id} (status ${j.status || "RUNNING"}). ` +
                `Call siteglass_get_scan with crawl_id=${start.crawl_id} in ~20s.`);
  }
);

server.tool(
  "siteglass_get_scan",
  "Read a scan's report + findings by crawl_id (use after siteglass_scan if it was still running).",
  { crawl_id: z.string() },
  async ({ crawl_id }) => {
    const j = await api("GET", `/api/crawls/${crawl_id}`);
    if (!j.ok) return text(`Error: ${j.error}`);
    return text(j.status === "DONE" ? scanSummary(j) : `Scan status: ${j.status}. Check again shortly.`);
  }
);

server.tool(
  "siteglass_generate_flows",
  "Derive executable E2E test flows from a scan (LLM). Step 4. Returns flow ids.",
  { crawl_id: z.string() },
  async ({ crawl_id }) => {
    const path = `/api/crawls/${crawl_id}/flows`;
    // Status (generating/flows) lives on the GET; the POST only TRIGGERS and
    // returns {ok, flows:[]}. Flows persist, so only (re)trigger when there are
    // none — repeat calls then cost nothing and just return what's there.
    let j = await api("GET", path);
    if (!j.generating && !(j.flows || []).length) {
      const trig = await api("POST", path);
      if (!trig.ok) return text(`Error: ${trig.error}`);
      j = await api("GET", path);
    }
    // Poll until generation finishes — OR the flow count holds steady for two
    // reads (the backend can leave `generating` stuck true even when done).
    const deadline = Date.now() + 50000;
    let prev = -1, stable = 0;
    while (j.generating && Date.now() < deadline) {
      const n = (j.flows || []).length;
      if (n > 0 && n === prev) { if (++stable >= 2) break; } else stable = 0;
      prev = n;
      await new Promise((r) => setTimeout(r, 2500));
      j = await api("GET", path);
    }
    if (j.gen_error) return text(`Flow generation failed: ${j.gen_error}`);
    const flows = j.flows || [];
    if (!flows.length) return text(`No test flows were generated for this scan.`);
    return text(`Generated ${flows.length} flow(s)${j.generating ? " (generation still finishing)" : ""}:\n` +
      flows.map((x) => `  ${x.id}  [${x.destructive ? "destructive" : "safe"}]  ${x.name}${x.description ? " — " + x.description : ""}`).join("\n") +
      `\n\nRun one with siteglass_run_flow. Destructive flows: full=false dry-runs the final submit; full=true submits for real (a passing Run Full of a sign-up flow auto-saves the new account as this site's test credentials).`);
  }
);

server.tool(
  "siteglass_run_flow",
  "Run one test flow. Returns a run_id; if still running, poll with siteglass_get_run. Step 5.",
  { flow_id: z.string(), full: z.boolean().optional().describe("true = submit destructive actions for real (default false)") },
  async ({ flow_id, full }) => {
    const start = await api("POST", `/api/flows/${flow_id}/run`, { full: !!full });
    if (!start.ok) return text(`Cannot run: ${start.error}`);
    const j = await poll(`/api/flow-runs/${start.run_id}`);
    if (j.status === "DONE") return text(runSummary(j));
    return text(`Run started. run_id: ${start.run_id} (status ${j.status || "RUNNING"}). ` +
                `Call siteglass_get_run with run_id=${start.run_id} in ~20s.`);
  }
);

server.tool(
  "siteglass_get_run",
  "Read a flow run's per-step results + capture URLs by run_id (use after siteglass_run_flow if still running).",
  { run_id: z.string() },
  async ({ run_id }) => {
    const j = await api("GET", `/api/flow-runs/${run_id}`);
    if (!j.ok) return text(`Error: ${j.error}`);
    return text(j.status === "DONE" ? runSummary(j) : `Run status: ${j.status}. Check again shortly.`);
  }
);

server.tool(
  "siteglass_render",
  "Archive ANY public web page for a few sats — a permanent, shareable snapshot, returned as a permalink. The bot-friendly alternative to archive.today: no CAPTCHA, no signup, no ownership verification, callable programmatically. Default 'rrweb' captures the live rendered DOM (navigable, post-JS, selectable text + working links); 'pdf' is a single continuous page; 'png' a full-page image. Anonymous calls return a Lightning invoice (pay, then call siteglass_get_render); if your account has credits it archives immediately and returns the permalink.",
  { url: z.string().describe("Any public URL, e.g. https://example.com"),
    format: z.enum(["rrweb", "pdf", "png"]).optional().describe("rrweb (default, interactive DOM archive), pdf (single continuous page), or png (full-page image)") },
  async ({ url, format }) => {
    const j = await api("POST", "/api/render", { url, format: format || "rrweb" });
    if (!j.ok) return text(`Error: ${j.error}`);
    if (j.status === "done") return text(`Archived (paid with credits).\nPermalink: ${BASE}${j.open_url || j.file_url}`);
    return text(`Payment required: ${j.amount_sats} sats.\nPay this Lightning invoice:\n${j.invoice}\n\n` +
                `Then call siteglass_get_render with job_id=${j.job_id} to fetch the ${j.format}.`);
  }
);

server.tool(
  "siteglass_get_render",
  "Fetch an archive once its Lightning invoice is paid. Returns the permalink when ready, or a pending status.",
  { job_id: z.string() },
  async ({ job_id }) => {
    const j = await api("GET", `/api/render/${job_id}`);
    if (!j.ok) return text(`Error: ${j.error}`);
    return text(j.status === "done"
      ? `Ready.\nPermalink: ${BASE}${j.open_url || j.file_url}`
      : `Still awaiting payment (${j.amount_sats} sats). Invoice:\n${j.invoice}`);
  }
);

server.tool(
  "siteglass_set_credentials",
  "Provide a test account (username/password) so authenticated flows can log in to the site.",
  { site_id: z.string(), username: z.string(), password: z.string() },
  async ({ site_id, username, password }) => {
    const j = await api("POST", `/api/sites/${site_id}/credentials`, { vars: { username, password } });
    return text(j.ok ? "Test credentials saved." : `Error: ${j.error}`);
  }
);

server.tool(
  "siteglass_feedback",
  "Send feedback to the siteglass team (bugs, missing features, anything). Works for agents and people alike.",
  { message: z.string(), context: z.string().optional() },
  async ({ message, context }) => {
    const j = await api("POST", "/api/feedback", { message, context });
    return text(j.ok ? "Thanks — feedback received." : `Error: ${j.error}`);
  }
);

// --- free local dev-scan --------------------------------------------
// Runs the bundled crawler on the USER's machine (their browser, their
// localhost — nothing tunneled to us), then siteglass analyzes the crawl
// server-side. No account, no ownership verification, no payment.
function runCrawl(url, maxPages) {
  return new Promise((resolve, reject) => {
    const opts = JSON.stringify({ maxPages, maxDepth: 2, timeoutMs: 20000, screenshot: false });
    const child = spawn(process.execPath, [path.join(HERE, "crawl.cjs"), url, opts], { env: process.env });
    let out = "", err = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.on("close", () => {
      clearTimeout(killer);
      const s = out.trim();
      if (!s) return reject(new Error(err.trim() || "crawler produced no output"));
      resolve(s);
    });
  });
}

function installChromium() {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--yes", "playwright", "install", "chromium"],
      { stdio: "ignore", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (c) => (c === 0 ? resolve() : reject(new Error("browser install failed"))));
  });
}

server.tool(
  "siteglass_scan_local",
  "Scan a web app you're building — FREE: no account, no ownership verification, no payment. Runs a headless browser on YOUR machine to crawl the URL (works on http://localhost:PORT or any URL your machine can reach — nothing is tunneled to siteglass), then siteglass analyzes the crawl server-side and returns real findings: broken links/assets, console errors, accessibility & SEO issues, forms worth testing — plus a plain-English report. Point it at your local dev server right after your agent builds or changes the app. (First run may download a headless Chromium, ~1 min.)",
  {
    url: z.string().describe("App URL to scan, e.g. http://localhost:3000"),
    max_pages: z.number().int().min(1).max(30).optional().describe("Max same-origin pages to crawl (default 10)"),
  },
  async ({ url, max_pages }) => {
    const maxPages = max_pages || 10;
    let raw;
    try {
      raw = await runCrawl(url, maxPages);
    } catch (e) {
      return text(`Local crawl failed: ${e.message}\nIs a dev server actually running at ${url}?`);
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    // If the crawler couldn't launch a browser, install one on demand and retry.
    if (parsed && parsed.ok === false && /executable doesn'?t exist|playwright install|\.launch/i.test(parsed.error || "")) {
      try {
        await installChromium();
        raw = await runCrawl(url, maxPages);
        parsed = JSON.parse(raw);
      } catch (e) {
        return text(`Needed a headless browser but couldn't set one up: ${e.message}\nRun this once, then retry: npx playwright install chromium`);
      }
    }
    if (parsed && parsed.ok === false) return text(`Crawl error: ${parsed.error}`);
    let j;
    try {
      const r = await fetch(`${BASE}/api/local-scan`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
      });
      j = await r.json();
    } catch (e) { return text(`Analysis request failed: ${e.message}`); }
    if (!j || !j.ok) return text(`Analysis error: ${(j && j.error) || "unknown"}`);
    const findings = (j.findings || [])
      .map((f) => `  [${f.severity}/${f.kind}] ${f.title}${f.detail ? "\n      " + f.detail : ""}`)
      .join("\n") || "  (no issues found)";
    return text(`siteglass local scan of ${url} — ${j.count} finding(s):\n\n${findings}\n\n--- report ---\n${j.report}`);
  }
);

await server.connect(new StdioServerTransport());
