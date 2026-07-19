// siteglass/crawl.js — headless-Chromium crawler for siteglass.io.
//
// Renders a site (JS included) with the project's existing Playwright
// browser-in-a-box and emits a single JSON document on stdout describing
// what's on the site and how it's organized. The Lisp side
// (siteglass.crawl) shells out to this and parses the result with jzon —
// same shell-out-and-read-JSON pattern as shared/sports/inspect/.
//
//   NODE_PATH=~/pw/node_modules node shared/siteglass/crawl.js <url> [opts-json]
//
// opts-json (optional 2nd arg): {"maxPages":12,"maxDepth":2,"timeoutMs":20000,
//                                "ua":"...", "screenshot":false}
//
// Crawl is same-origin BFS, sequential (one tab), polite. Every page
// records structure (title/meta/headings/links/forms/assets) plus
// Navigation-Timing v2 metrics (ttfb, domContentLoaded, load, transfer
// size) so the report layer gets a cheap perf read without Lighthouse.
// All failures are captured into errors[] rather than aborting the crawl.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const AXE = fs.readFileSync(path.join(__dirname, 'vendor', 'axe.min.js'), 'utf8'); // accessibility audit

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function die(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(msg) }));
  process.exit(1);
}

// Normalize a URL for dedup: drop hash, drop trailing slash, lowercase host.
function canon(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

// What we extract from each rendered page, entirely in-browser so the Lisp
// side never has to parse HTML. Returns a plain JSON-able object.
const EXTRACT = () => {
  const txt = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const abs = (href) => { try { return new URL(href, location.href).toString(); } catch { return null; } };
  const here = location.origin;

  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .map(a => ({ href: abs(a.getAttribute('href')), text: txt(a).slice(0, 120) }))
    .filter(a => a.href && (a.href.startsWith('http')));
  const internal = anchors.filter(a => { try { return new URL(a.href).origin === here; } catch { return false; } });
  const external = anchors.filter(a => { try { return new URL(a.href).origin !== here; } catch { return false; } });

  const forms = Array.from(document.querySelectorAll('form')).map(f => ({
    action: abs(f.getAttribute('action') || location.href),
    method: (f.getAttribute('method') || 'get').toLowerCase(),
    fields: Array.from(f.querySelectorAll('input,select,textarea')).map(i => ({
      name: i.getAttribute('name') || null,
      type: (i.getAttribute('type') || i.tagName.toLowerCase()),
      required: i.hasAttribute('required'),
    })).slice(0, 40),
  }));

  const headings = {};
  for (const tag of ['h1', 'h2', 'h3']) {
    headings[tag] = Array.from(document.querySelectorAll(tag)).map(h => txt(h).slice(0, 160)).filter(Boolean).slice(0, 25);
  }

  const meta = (sel, attr = 'content') => { const m = document.querySelector(sel); return m ? m.getAttribute(attr) : null; };

  // Navigation Timing L2 — cheap perf signal.
  let timing = null, transfer = null;
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      timing = {
        ttfbMs: Math.round(nav.responseStart),
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd || nav.domComplete),
        responseEndMs: Math.round(nav.responseEnd),
      };
      transfer = { transferSize: nav.transferSize || 0, encodedBodySize: nav.encodedBodySize || 0, decodedBodySize: nav.decodedBodySize || 0 };
    }
  } catch { /* timing optional */ }

  const resources = (() => {
    try {
      const rs = performance.getEntriesByType('resource');
      const by = {}; let bytes = 0;
      for (const r of rs) {
        by[r.initiatorType] = (by[r.initiatorType] || 0) + 1;
        bytes += r.transferSize || 0;
      }
      return { count: rs.length, byType: by, transferBytes: bytes };
    } catch { return null; }
  })();

  return {
    title: document.title || null,
    lang: document.documentElement.getAttribute('lang') || null,
    metaDescription: meta('meta[name="description"]'),
    metaViewport: meta('meta[name="viewport"]'),
    canonical: (() => { const l = document.querySelector('link[rel="canonical"]'); return l ? abs(l.getAttribute('href')) : null; })(),
    og: { title: meta('meta[property="og:title"]'), type: meta('meta[property="og:type"]'), image: meta('meta[property="og:image"]') },
    headings,
    counts: {
      links: anchors.length, internalLinks: internal.length, externalLinks: external.length,
      forms: forms.length, images: document.images.length,
      scripts: document.scripts.length,
      stylesheets: document.querySelectorAll('link[rel="stylesheet"]').length,
      buttons: document.querySelectorAll('button,[role="button"],input[type="submit"]').length,
      iframes: document.querySelectorAll('iframe').length,
    },
    wordCount: (document.body ? (document.body.innerText || '').split(/\s+/).filter(Boolean).length : 0),
    forms,
    timing, transfer, resources,
    _internalHrefs: internal.map(a => a.href),
  };
};

(async () => {
  const url = process.argv[2];
  if (!url) die('usage: crawl.js <url> [opts-json]');
  let opts = {};
  try { if (process.argv[3]) opts = JSON.parse(process.argv[3]); } catch (e) { die('bad opts json: ' + e.message); }
  const maxPages = opts.maxPages || 12;
  const maxDepth = opts.maxDepth == null ? 2 : opts.maxDepth;
  const timeoutMs = opts.timeoutMs || 20000;
  const ua = opts.ua || DEFAULT_UA;
  const shotPath = opts.screenshotPath || null;  // capture the home page for the visual pass
  const shotDir = opts.shotDir || null;          // capture EVERY page here (page-N.png) for the portal/diagram
  let _shot = null;
  // Referer the owner sees in their analytics — a permalink to THIS scan, so a
  // click is an instant personalized demo. Falls back to the marketing site.
  const referer = opts.referer || 'https://siteglass.io/';
  const login = opts.login || null;              // optional: log in once, then crawl authenticated
  let _auth = false;
  const lite = opts.lite || null;                // lite: home page + a few clicks, no full spider
  let _liteClicks = null;
  // console / JS errors, captured on BOTH lite and full scans — a strong
  // "is it actually working" signal. Capped so an error-spammy SPA can't bloat
  // the payload.
  const consoleErrors = [];
  const pushErr = (step, text) => { if (consoleErrors.length < 300) consoleErrors.push({ step, text: String(text).slice(0, 200) }); };

  const start = canon(url);
  if (!start) die('unparseable start url: ' + url);
  const startOrigin = new URL(start).origin;

  const _wall0 = Date.now();
  let _netIn = 0, _netOut = 0, _netReq = 0; const _pending = [];
  const broken = []; let _curUrl = null;   // broken links/assets (4xx/5xx responses)
  const apiCalls = [];                      // passive API-surface map: the xhr/fetch the PAGE itself makes

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const pages = [];
  const errors = [];
  const seen = new Set([start]);
  const queue = [{ url: start, depth: 0 }];

  try {
    // ignoreHTTPSErrors: real client sites (and tunnels with mismatched
    // certs) shouldn't block the crawl — we report what's there regardless.
    const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true,
      // every request carries the scan permalink as Referer — owner clicks it -> instant demo
      extraHTTPHeaders: { 'Referer': referer } });
    // Meter real transfer sizes (responseBodySize etc.) per finished request.
    ctx.on('requestfinished', req => { _netReq++; _pending.push(
      req.sizes().then(s => { _netIn += (s.responseBodySize||0)+(s.responseHeadersSize||0);
                              _netOut += (s.requestBodySize||0)+(s.requestHeadersSize||0); })
                 .catch(()=>{})); });
    // broken links/assets: any 4xx/5xx response, attributed to the page being loaded.
    ctx.on('response', r => { try { const s = r.status();
      if (s >= 400) broken.push({ url: r.url().slice(0,200), status: s, on: _curUrl });
      // passive backend-API discovery: record only the xhr/fetch (and JSON)
      // calls the page itself makes — never a request we craft, never a probe.
      const req = r.request(); const rt = req.resourceType();
      const ct = (r.headers()['content-type'] || '');
      if (rt === 'xhr' || rt === 'fetch' || ct.includes('json')) {
        apiCalls.push({ method: req.method(), url: r.url().slice(0,300), status: s,
                        type: rt, ctype: ct.split(';')[0].trim() }); }
    } catch(_){} });

    // Optional authenticated crawl: log in once. The context (cookies +
    // localStorage / session token) is reused for every page that follows, so
    // the rest of the crawl renders the site as a signed-in user sees it.
    if (login) {
      const lpage = await ctx.newPage();
      try {
        const lurl = login.url || start;
        await lpage.goto(lurl, { waitUntil: 'networkidle', timeout: timeoutMs })
          .catch(() => lpage.goto(lurl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }));
        // explicit selectors win; otherwise sniff the form.
        const passSel = login.passSel ||
          'input[type=password]';
        const userSel = login.userSel ||
          'input[type=email],input[name=username],input[name=email],input[name=user],input[type=text]';
        const submitSel = login.submitSel ||
          'button[type=submit],input[type=submit],form button';
        await lpage.waitForSelector(passSel, { timeout: timeoutMs });
        if (login.username != null) await lpage.fill(userSel, String(login.username)).catch(()=>{});
        await lpage.fill(passSel, String(login.password != null ? login.password : ''));
        await Promise.all([
          lpage.waitForLoadState('networkidle').catch(()=>{}),
          lpage.click(submitSel).catch(() => lpage.press(passSel, 'Enter')),
        ]);
        await lpage.waitForTimeout(1800);   // let an SPA store its token / set cookies
        _auth = true;
      } catch (e) {
        errors.push({ url: 'login', error: 'login failed: ' + String(e.message || e) });
      } finally { await lpage.close().catch(()=>{}); }
    }

    // Give a JS app a FAIR chance to render real content before we judge it
    // empty/broken. Returns the instant the body has substantive text; only a
    // genuinely-blank page waits the full window. Never give up sooner — an
    // eval must not call a slow-rendering SPA "empty" because we were impatient.
    // (Operator: at least 30s before giving up — less is too risky for an eval.)
    const settle = async (p, maxMs) => {
      await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      try {
        await p.waitForFunction(
          () => { const t = document.body && document.body.innerText;
                  return t ? t.trim().split(/\s+/).filter(Boolean).length >= 40 : false; },
          { timeout: maxMs, polling: 700 });
      } catch (_) { /* waited the full window; proceed with whatever rendered */ }
    };

    if (lite) {
      // LITE scan: load the home page, then click a few prominent, SAFE controls.
      // A quick "does it look right / does it work" pass — not a full spider.
      const page = await ctx.newPage();
      let _step = 'load';
      page.on('console', m => { if (m.type() === 'error') pushErr(_step, m.text()); });
      page.on('pageerror', e => pushErr(_step, 'PAGEERROR: ' + (e.message || e)));

      const VITALS = () => new Promise(res => {
        let lcp = 0, cls = 0;
        try { new PerformanceObserver(l => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type:'largest-contentful-paint', buffered:true }); } catch(_){}
        try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type:'layout-shift', buffered:true }); } catch(_){}
        setTimeout(() => { const f = performance.getEntriesByName('first-contentful-paint')[0];
          res({ lcp: Math.round(lcp), cls: Math.round(cls*1000)/1000, fcp: f ? Math.round(f.startTime) : null }); }, 350);
      });

      // --- home page ---
      _curUrl = start;
      const home = { url: start, depth: 0 };
      const resp = await page.goto(start, { waitUntil:'domcontentloaded', timeout:timeoutMs }).catch(() => null);
      await settle(page, 30000);  // >=30s for the home page to actually render before we judge it
      home.status = resp ? resp.status() : null;
      home.contentType = resp ? (resp.headers()['content-type'] || '') : '';
      home.finalUrl = canon(page.url());
      try { const d = await page.evaluate(EXTRACT); delete d._internalHrefs; Object.assign(home, d); } catch(_){}
      home.vitals = await page.evaluate(VITALS).catch(() => null);
      if (/html/i.test(home.contentType || '')) try {
        await page.addScriptTag({ content: AXE });
        home.a11y = await page.evaluate(async () => { const r = await axe.run(document, { resultTypes:['violations'], runOnly:['wcag2a','wcag2aa'] });
          return { violations:r.violations.length, nodes:r.violations.reduce((n,v)=>n+v.nodes.length,0),
                   top:r.violations.sort((a,b)=>b.nodes.length-a.nodes.length).slice(0,8).map(v=>({id:v.id,impact:v.impact,help:v.help,count:v.nodes.length})) }; });
      } catch(_) { home.a11y = null; }
      if (shotPath) { try { await page.screenshot({ path: shotPath }); _shot = shotPath; } catch(_){} }
      if (shotDir) { try { await page.screenshot({ path: path.join(shotDir, 'page-0.png') }); home.shot = 'page-0.png'; } catch(_){} }
      pages.push(home);

      // Tag the idx-th REAL control on the current page with data-sg-pick, and
      // return its {kind,name} (or null when there are fewer than idx+1). Re-run
      // after each reset so we click a precise element by selector — never by a
      // fragile getByRole(name), which times out on big role=button feed cards.
      // Filters to genuine controls: short label, sane size (skips full-width
      // cards/hero blocks), visible, same-origin links, non-destructive.
      const DESTRUCTIVE = 'log\\s?out|sign\\s?out|delete|remove|cancel|unsubscribe|buy|purchase|checkout|\\bpay\\b|subscribe|download|destroy|deactivate';
      const tagNth = ({ destSrc, idx }) => {
        const dest = new RegExp(destSrc, 'i');
        const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
          return r.width > 8 && r.height > 8 && r.width < 900 && r.height < 160 &&
                 s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none' &&
                 r.bottom > 0 && r.top < innerHeight * 2.5; };
        const out = [], seen = new Set();
        const add = (el, kind, name, area, top) => { name = (name||'').trim().replace(/\s+/g,' ');
          if (name.length < 2 || name.length > 40 || dest.test(name) || seen.has(kind+name)) return;
          seen.add(kind+name); out.push({ el, kind, name, score: area - top*3 }); };
        for (const b of document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]'))
          if (vis(b)) { const r=b.getBoundingClientRect(); add(b, 'button', b.innerText||b.value||b.getAttribute('aria-label'), r.width*r.height, r.top); }
        for (const a of document.querySelectorAll('a[href]')) { if (!vis(a)) continue;
          let same=false; try { same = new URL(a.href, location.href).origin === location.origin; } catch(_){}
          const href = a.getAttribute('href') || '';
          if (!same || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
          const r=a.getBoundingClientRect(); add(a, 'link', a.innerText, r.width*r.height, r.top); }
        out.sort((x,y)=>y.score-x.score);
        document.querySelectorAll('[data-sg-pick]').forEach(e => e.removeAttribute('data-sg-pick'));
        const c = out[idx]; if (!c) return null;
        c.el.setAttribute('data-sg-pick', '1');
        return { kind: c.kind, name: c.name };
      };

      const clicks = [];
      const capture = async (rec, before) => {
        // Let any navigation the click triggered actually commit + load before we
        // judge where we ended up — SSO/external redirect chains take a beat, and
        // classifying too early reads an in-between URL. Off/on-site are decided
        // from the SAME final URL so they can never disagree.
        await page.waitForTimeout(1200);
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(()=>{});
        const landed = page.url();
        let off = false; try { off = new URL(landed).origin !== startOrigin; } catch(_) { off = true; }
        if (off) {
          // Left the site (external link or an SSO button like "Sign in with
          // GitHub"). The third party often won't render headless (chrome-error)
          // — that is NOT the site being broken or bot-blocked, just an off-site
          // link. Record it as such; the loop will try another control instead.
          rec.offOrigin = true; rec.leftSite = true; rec.navigated = true;
          rec.finalUrl = landed.startsWith('chrome-error')
            ? '(external site — did not render headless)' : canon(landed);
        } else {
          await settle(page, 10000);  // on-site: let the click's destination render
          rec.offOrigin = false;
          rec.finalUrl = canon(page.url());
          rec.navigated = rec.finalUrl !== home.finalUrl;
        }
        rec.title = await page.title().catch(() => null);
        rec.newErrors = consoleErrors.slice(before).map(x => x.text);
        if (shotDir) { const fn = 'page-' + pages.length + '.png';
          try { await page.screenshot({ path: path.join(shotDir, fn) }); rec.shot = fn; } catch(_){} }
        clicks.push(rec); pages.push(rec);
      };

      // Collect up to 4 clicks that stay ON the site. Off-site links (SSO /
      // external) are recorded but don't consume the quota, so we keep advancing
      // to further controls (up to 9 tries) and actually exercise the app instead
      // of burning all 4 clicks wandering off to chrome-error pages.
      let onOrigin = 0;
      for (let i = 0; i < 9 && onOrigin < 4; i++) {
        // reset to home so each click is independent, then re-tag the i-th control.
        await page.goto(start, { waitUntil:'domcontentloaded', timeout:timeoutMs }).catch(()=>{});
        await page.waitForTimeout(250);
        const picked = await page.evaluate(tagNth, { destSrc: DESTRUCTIVE, idx: i }).catch(()=>null);
        if (!picked) break;
        _step = 'click:' + picked.name;
        const before = consoleErrors.length;
        const rec = { url: start, depth: 1, click: picked.name, clickKind: picked.kind };
        try { await page.click('[data-sg-pick]', { timeout: 4000 }); }
        catch (e) { rec.clickError = String(e.message || e).slice(0, 160); }
        await capture(rec, before);
        if (!rec.offOrigin) onOrigin++;
      }

      // Canvas / app-shaped pages (e.g. a visualizer with no real buttons): if we
      // found few controls, poke the largest canvas so there's *some* interaction.
      if (clicks.length < 2) {
        await page.goto(start, { waitUntil:'domcontentloaded', timeout:timeoutMs }).catch(()=>{});
        await page.waitForTimeout(400);
        const box = await page.evaluate(() => {
          const c = [...document.querySelectorAll('canvas')].map(e => e.getBoundingClientRect())
            .filter(r => r.width > 200 && r.height > 150).sort((a,b)=>b.width*b.height - a.width*a.height)[0];
          return c ? { x: Math.round(c.x + c.width/2), y: Math.round(c.y + c.height/2) } : null;
        }).catch(()=>null);
        if (box) {
          _step = 'canvas';
          const before = consoleErrors.length;
          const rec = { url: start, depth: 1, click: 'canvas (center)', clickKind: 'canvas' };
          try { await page.mouse.click(box.x, box.y); } catch (e) { rec.clickError = String(e.message || e).slice(0,160); }
          await capture(rec, before);
        }
      }
      _liteClicks = clicks;
      await page.close().catch(() => {});
    } else
    while (queue.length && pages.length < maxPages) {
      const { url: u, depth } = queue.shift();
      _curUrl = u;
      const page = await ctx.newPage();
      // capture console/JS errors for this page (attributed to its URL)
      page.on('console', m => { if (m.type() === 'error') pushErr(u, m.text()); });
      page.on('pageerror', e => pushErr(u, 'PAGEERROR: ' + (e.message || e)));
      const rec = { url: u, depth };
      try {
        const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null);
        // Settle for JS/SPA renders: wait for real content, up to 30s. Returns
        // the instant the body has substantive text, so fast pages aren't
        // slowed and only a truly-blank page burns the window — chatty apps
        // (live websocket feeds, Nostr relays) never reach networkidle, but
        // they DO paint content, which is what we actually wait on.
        await settle(page, 30000);
        rec.status = resp ? resp.status() : null;
        rec.contentType = resp ? (resp.headers()['content-type'] || '') : '';
        rec.finalUrl = canon(page.url());
        const data = await page.evaluate(EXTRACT);
        const hrefs = data._internalHrefs || [];
        delete data._internalHrefs;
        Object.assign(rec, data);

        // Core Web Vitals (LCP / CLS / FCP) measured on the live page.
        rec.vitals = await page.evaluate(() => new Promise(res => {
          let lcp = 0, cls = 0;
          try { new PerformanceObserver(l => { for (const e of l.getEntries()) lcp = e.startTime; }).observe({ type:'largest-contentful-paint', buffered:true }); } catch(_){}
          try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type:'layout-shift', buffered:true }); } catch(_){}
          setTimeout(() => { const f = performance.getEntriesByName('first-contentful-paint')[0];
            res({ lcp: Math.round(lcp), cls: Math.round(cls*1000)/1000, fcp: f ? Math.round(f.startTime) : null }); }, 350);
        })).catch(() => null);

        // Accessibility audit (axe-core, WCAG 2 A/AA) — compact violation summary.
        // HTML documents only: on text/markdown/json/plain the browser shows a
        // generated <pre> wrapper (no lang/title), which axe would flag as
        // bogus violations that aren't ours. Skip those.
        const isHtml = /html/i.test(rec.contentType || '');
        if (isHtml) try {
          await page.addScriptTag({ content: AXE });
          rec.a11y = await page.evaluate(async () => {
            const r = await axe.run(document, { resultTypes:['violations'], runOnly:['wcag2a','wcag2aa'] });
            return { violations: r.violations.length,
                     nodes: r.violations.reduce((n,v) => n + v.nodes.length, 0),
                     top: r.violations.sort((a,b) => b.nodes.length - a.nodes.length).slice(0,8)
                            .map(v => ({ id:v.id, impact:v.impact, help:v.help, count:v.nodes.length })) };
          });
        } catch(_) { rec.a11y = null; }

        // home-page screenshot for the forensic visual pass (first page only)
        if (pages.length === 0 && shotPath) {
          try { await page.screenshot({ path: shotPath }); _shot = shotPath; } catch (_) {}
        }
        // per-page screenshot into the scan's persistent asset dir (page-N.png),
        // for the portal gallery and the site diagram thumbnails.
        if (shotDir) {
          const fn = 'page-' + pages.length + '.png';
          try { await page.screenshot({ path: path.join(shotDir, fn) }); rec.shot = fn; } catch (_) {}
        }
        // outgoing internal links (canon'd, deduped) — the edges of the site graph.
        rec.links = [...new Set(hrefs.map(canon).filter(Boolean))].slice(0, 60);

        if (depth < maxDepth) {
          for (const h of hrefs) {
            const c = canon(h);
            if (c && !seen.has(c) && new URL(c).origin === startOrigin) {
              seen.add(c);
              queue.push({ url: c, depth: depth + 1 });
            }
          }
        }
        pages.push(rec);
      } catch (e) {
        errors.push({ url: u, error: String(e.message || e) });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (e) {
    errors.push({ url: start, error: 'fatal: ' + String(e.message || e) });
  } finally {
    await browser.close().catch(() => {});
  }

  await Promise.allSettled(_pending);
  const _ru = process.resourceUsage();
  process.stdout.write(JSON.stringify({
    ok: true,
    authenticated: _auth,
    lite: !!lite,
    clicks: _liteClicks || [],
    consoleErrors,
    start, startOrigin,
    pageCount: pages.length,
    discovered: seen.size,
    pages, errors,
    broken: (() => { const seen = new Set(), out = [];
      for (const b of broken) { const k = b.status + ' ' + b.url; if (!seen.has(k)) { seen.add(k); out.push(b); } }
      return out.slice(0, 50); })(),
    api_calls: (() => { const seen = new Set(), out = [];
      for (const a of apiCalls) {
        let key; try { const u = new URL(a.url); key = a.method + ' ' + u.origin + u.pathname; }
                 catch { key = a.method + ' ' + a.url; }
        if (!seen.has(key)) { seen.add(key); out.push(a); } }
      return out.slice(0, 80); })(),
    _shot,
    _res: {
      wall_ms: Date.now() - _wall0,
      cpu_user_ms: Math.round(_ru.userCPUTime / 1000),
      cpu_sys_ms: Math.round(_ru.systemCPUTime / 1000),
      max_rss_kb: _ru.maxRSS,
      net_in_bytes: _netIn, net_out_bytes: _netOut, net_requests: _netReq,
    },
  }));
})().catch(die);
