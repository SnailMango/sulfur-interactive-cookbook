'use strict';
/**
 * Local server (127.0.0.1 only) acting as the "backend" of the overlay UI.
 *   GET  /                   the page (renderer/index.html)
 *   GET  /api/data           recipes + stats + the user's own translations
 *   GET  /api/status         progress of the running task (data update / auto-translation)
 *   POST /api/update         download the latest data from GitHub
 *   POST /api/alias          save an Italian item name
 *   POST /api/text           save the translation of an effect line
 *   POST /api/autotranslate  draft Italian item names through MyMemory
 *   GET  /icons/<file>       icons (downloaded from the wiki on first request, then cached)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const UA = 'SULFUR-Interactive-Cookbook/1.0 (+https://github.com/SnailMango/sulfur-interactive-cookbook)';
const DEFAULTS = require('./defaults.json');
const AUTO_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, obj, pretty) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty ? 1 : 0), 'utf8');
  fs.renameSync(tmp, file);
}
const sortedObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function startServer(opts) {
  const { dataDir, appDir } = opts;
  const config = opts.config || {};
  const files = {
    data: path.join(dataDir, 'recipes.json'),
    bundled: path.join(appDir, 'data', 'recipes.json'),
    aliases: path.join(dataDir, 'it_en.json'),
    texts: path.join(dataDir, 'it_texts.json'),
    glossary: path.join(dataDir, 'it_glossary.json'),
    meta: path.join(dataDir, 'meta.json'),
    icons: path.join(dataDir, 'icons'),
    page: path.join(appDir, 'renderer', 'index.html'),
  };
  fs.mkdirSync(files.icons, { recursive: true });

  const STATUS = { running: false, msg: '', code: '', args: {}, error: null };
  // Messages are sent as a code + arguments; the UI translates them (EN/IT). `msg` is an English fallback.
  const MSG = {
    dl: 'Downloading the latest data…',
    updated: 'Data updated: {n} recipes ({date}).',
    uptodate: 'You already have the latest data ({date}).',
    dlfail: 'Could not download the data: {err}. Try again later.',
    trprog: 'Translating names… {k}/{n}',
    trquota: 'Daily limit of the translation service reached: {added} names translated. Try again tomorrow or finish by hand.',
    trdown: 'The translation service is not responding: check your connection and try again later.',
    trdone: 'Automatic translation complete: {added} names added (review them with the pencil ✎).',
    trerr: 'Translation error: {err}',
  };
  const fmt = (s, a) => s.replace(/\{(\w+)\}/g, (_, k) => (a && a[k] !== undefined ? a[k] : ''));
  const say = (code, args) => { STATUS.code = code; STATUS.args = args || {}; STATUS.msg = fmt(MSG[code] || code, args); };

  const dataUrl = () =>
    process.env.SULFUR_DATA_URL ||
    `https://raw.githubusercontent.com/${config.repo}/${config.branch || 'main'}/data/recipes.json`;

  /* ---------------- dati ---------------- */
  function loadData() {
    const d = readJson(files.data, null) || readJson(files.bundled, null);
    return d || { recipes: [], cats: {}, items: [], ingredients: [], groups: [], gm: {}, icons: {}, iconUrls: {}, info: {}, fetched: [], empty: true };
  }
  // Names shipped with the app are merged with the user's own file. The user's choices always win:
  // a bundled name is added only if the user has no name at all for that item.
  function loadAliases() {
    const user = readJson(files.aliases, {});
    const taken = new Set(Object.values(user));
    const merged = Object.assign({}, user);
    for (const [it, en] of Object.entries(DEFAULTS.aliases || {})) {
      if (!taken.has(en) && !(it in merged)) merged[it] = en;
    }
    return merged;
  }
  function loadTexts() {
    return Object.assign({}, DEFAULTS.texts || {}, readJson(files.texts, {}));
  }
  function loadGlossary() {
    if (!fs.existsSync(files.glossary)) writeJson(files.glossary, DEFAULTS.glossary, true);
    const out = JSON.parse(JSON.stringify(DEFAULTS.glossary));
    const user = readJson(files.glossary, {});
    for (const k of Object.keys(user)) out[k] = Object.assign(out[k] || {}, user[k]);
    return out;
  }

  /* ---------------- aggiornamento dati da GitHub ---------------- */
  async function runUpdate(force) {
    if (STATUS.running) return;
    STATUS.running = true; STATUS.error = null;
    try {
      say('dl');
      const res = await fetch(dataUrl(), { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      const remote = await res.json();
      if (!Array.isArray(remote.recipes) || remote.recipes.length < 50) throw new Error('invalid data file');
      const local = readJson(files.data, null);
      if (!force && local && local.version && remote.version && local.version >= remote.version) {
        say('uptodate', { date: local.updated || local.version });
      } else {
        writeJson(files.data, remote);
        say('updated', { n: remote.recipes.length, date: remote.updated || remote.version });
      }
      writeJson(files.meta, Object.assign(readJson(files.meta, {}), { lastCheck: Date.now() }));
    } catch (e) {
      STATUS.error = String(e.message || e);
      say('dlfail', { err: STATUS.error });
    } finally {
      STATUS.running = false;
    }
  }
  function maybeAutoUpdate() {
    const meta = readJson(files.meta, {});
    const hasData = fs.existsSync(files.data);
    if (!hasData || !meta.lastCheck || Date.now() - meta.lastCheck > AUTO_CHECK_EVERY_MS) runUpdate(false);
  }

  /* ---------------- icone (cache locale, scaricate dalla wiki) ---------------- */
  const iconJobs = new Map();
  let iconActive = 0; const iconWait = [];
  async function withSlot(fn) {
    if (iconActive >= 4) await new Promise((r) => iconWait.push(r));
    iconActive++;
    try { return await fn(); } finally { iconActive--; const n = iconWait.shift(); if (n) n(); }
  }
  async function downloadIcon(name) {
    const url = (loadData().iconUrls || {})[name];
    if (!url) return false;
    return withSlot(async () => {
      for (let a = 0; a < 5; a++) {
        try {
          const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
          if (r.status === 429) { await sleep(Math.max(3000 * (a + 1), (Number(r.headers.get('retry-after')) || 0) * 1000)); continue; }
          if (!r.ok) return false;
          fs.writeFileSync(path.join(files.icons, name), Buffer.from(await r.arrayBuffer()));
          return true;
        } catch { await sleep(1500 * (a + 1)); }
      }
      return false;
    });
  }
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

  /* ---------------- traduzione automatica dei nomi (MyMemory) ---------------- */
  class Quota extends Error {}
  async function translateName(text) {
    const url = 'https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: text, langpair: 'en|it' });
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (r.status === 429) throw new Quota();
    const d = await r.json();
    const t = String((d.responseData || {}).translatedText || '');
    if (String(d.responseStatus) === '429' || t.toUpperCase().includes('MYMEMORY WARNING')) throw new Quota();
    if (String(d.responseStatus) !== '200') return null;
    return t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
  }
  async function autoTranslate() {
    if (STATUS.running) return;
    STATUS.running = true; STATUS.error = null;
    try {
      const db = loadData(); const al = loadAliases();
      const taken = new Set(Object.keys(al).map((k) => k.toLowerCase()));
      const have = new Set(Object.values(al));
      const todo = (db.items || []).filter((n) => !have.has(n));
      let added = 0, fails = 0, finished = true;
      for (let k = 0; k < todo.length; k++) {
        const n = todo[k]; say('trprog', { k: k + 1, n: todo.length });
        let t;
        try { t = await translateName(n); }
        catch (e) {
          if (e instanceof Quota) { say('trquota', { added }); finished = false; break; }
          if (++fails >= 3) { say('trdown'); finished = false; break; }
          continue;
        }
        fails = 0;
        if (t && t.toLowerCase() !== n.toLowerCase() && !taken.has(t.toLowerCase())) {
          al[t] = n; taken.add(t.toLowerCase()); added++;
          if (added % 10 === 0) writeJson(files.aliases, sortedObj(al), true);
        }
        await sleep(400);
      }
      writeJson(files.aliases, sortedObj(al), true);
      if (finished) say('trdone', { added });
    } catch (e) {
      STATUS.error = String(e.message || e); say('trerr', { err: STATUS.error });
    } finally { STATUS.running = false; }
  }

  /* ---------------- HTTP ---------------- */
  const send = (res, body, type, code) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code || 200, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  };
  const readBody = (req) => new Promise((resolve) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET') {
        if (p === '/') return send(res, fs.readFileSync(files.page), 'text/html; charset=utf-8');
        if (p === '/api/data') {
          const d = loadData();
          return send(res, Object.assign({}, d, { aliases: loadAliases(), texts: loadTexts(), glossary: loadGlossary() }));
        }
        if (p === '/api/status') return send(res, STATUS);
        if (p.startsWith('/icons/')) {
          const name = path.basename(decodeURIComponent(p.slice(7)));
          const f = path.join(files.icons, name);
          if (!fs.existsSync(f)) {
            if (!iconJobs.has(name)) iconJobs.set(name, downloadIcon(name).finally(() => iconJobs.delete(name)));
            await iconJobs.get(name);
          }
          if (fs.existsSync(f)) {
            const b = fs.readFileSync(f);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'image/png', 'Content-Length': b.length, 'Cache-Control': 'public, max-age=86400' });
            return res.end(b);
          }
          return send(res, '', 'text/plain', 404);
        }
        return send(res, {}, null, 404);
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (p === '/api/update') { if (!STATUS.running) runUpdate(false); return send(res, STATUS); }
        if (p === '/api/autotranslate') { if (!STATUS.running) autoTranslate(); return send(res, STATUS); }
        if (p === '/api/alias') {
          const it = String(body.it || '').trim(), en = String(body.en || '').trim();
          if (en) {
            // only the user's own file is edited here; bundled names stay in the app
            let a = readJson(files.aliases, {});
            if (body.replace) a = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== en));
            if (it) a[it] = en;
            writeJson(files.aliases, sortedObj(a), true);
          }
          return send(res, { ok: true });
        }
        if (p === '/api/text') {
          const en = String(body.en || '').trim(), it = String(body.it || '').trim();
          if (en) {
            const t = readJson(files.texts, {});
            if (it) t[en] = it; else delete t[en];
            writeJson(files.texts, sortedObj(t), true);
          }
          return send(res, { ok: true });
        }
      }
      return send(res, {}, null, 404);
    } catch (e) {
      return send(res, { error: String(e.message || e) }, null, 500);
    }
  }

  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.on('error', reject);
    srv.listen(opts.port || 0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, runUpdate, maybeAutoUpdate, status: STATUS, close: () => srv.close(), files });
    });
  });
}

module.exports = { startServer, norm };
