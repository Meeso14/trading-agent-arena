/*
 * Local server: runs the agent, talks to Alpaca, serves the game UI.
 * - Command line:  node server.js        (reads keys from .env, opens http://localhost:3777)
 * - Desktop app:   require('./server.js').startServer({...})  (keys + data folder passed in)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Game, SimBroker } = require('./core.js');
const { AlpacaBroker } = require('./alpaca.js');

function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.env      ALPACA_PAPER_KEY_ID, ALPACA_PAPER_SECRET, ALPACA_LIVE_KEY_ID, ALPACA_LIVE_SECRET, ALLOW_LIVE
 * @param {string} opts.dataDir  where progress is saved
 * @param {number} [opts.port]   preferred port; falls back to a free one if busy
 * @returns {Promise<{port:number, url:string, saveNow:Function, close:Function}>}
 */
function startServer(opts) {
  const env = opts.env || {};
  const paperKeys = !!(env.ALPACA_PAPER_KEY_ID && env.ALPACA_PAPER_SECRET);
  const liveKeys = !!(env.ALPACA_LIVE_KEY_ID && env.ALPACA_LIVE_SECRET);
  const liveAllowed = String(env.ALLOW_LIVE) === 'true' && liveKeys;

  const dataDir = opts.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const profile = paperKeys ? 'alpaca' : 'sim'; // paper + live share one brain; sim has its own
  const statePath = path.join(dataDir, `state-${profile}.json`);
  const simPath = path.join(dataDir, 'sim-market.json');
  const load = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

  const broker = paperKeys
    ? new AlpacaBroker({ keyId: env.ALPACA_PAPER_KEY_ID, secret: env.ALPACA_PAPER_SECRET, live: false })
    : new SimBroker(load(simPath));

  const clients = new Set();
  const broadcast = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); };
  const game = new Game({ broker, state: load(statePath) || {}, liveAvailable: liveAllowed, onEvent: (e) => broadcast('event', e) });
  game.running = false; // always start paused, and never resume in live mode after a restart

  // atomic save: write to a temp file, then rename, so a crash can't corrupt progress
  function saveNow() {
    const write = (p, obj) => { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, p); };
    try {
      write(statePath, game.toJSON());
      if (game.broker instanceof SimBroker) write(simPath, game.broker.toJSON());
    } catch (e) { console.error('save failed', e.message); }
  }
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); };

  let simSpeed = 1, stopped = false, loopTimer = null;
  const interval = () => (game.broker instanceof SimBroker ? 1000 / simSpeed : 30000);
  const snap = () => Object.assign(game.snapshot(), { simSpeed, isSim: game.broker instanceof SimBroker, liveAllowed, hasPaperKeys: paperKeys });
  async function loop() {
    if (stopped) return;
    await game.tick();
    broadcast('snapshot', snap());
    save();
    loopTimer = setTimeout(loop, interval());
  }

  async function command(cmd, args) {
    if (cmd === 'speed') { simSpeed = Math.max(0.5, Math.min(10, +args.value || 1)); return; }
    if (cmd === 'goLive') {
      const gate = game.liveUnlock();
      if (!gate.ok) throw new Error('Live mode is still locked: ' + gate.reqs.filter((r) => !r.ok).map((r) => r.label).join(', '));
      if (String(args.confirm || '').trim().toUpperCase() !== 'GO LIVE') throw new Error('Type GO LIVE to confirm');
      game.running = false;
      game.broker = new AlpacaBroker({ keyId: env.ALPACA_LIVE_KEY_ID, secret: env.ALPACA_LIVE_SECRET, live: true });
      game.mode = 'live'; game.metas = {}; game.day = { key: '', startEquity: null, trades: 0, halted: false };
      game.say('golive'); game.checkAchievements();
      return;
    }
    if (cmd === 'goPaper') {
      if (!paperKeys) throw new Error('No paper keys configured');
      game.running = false;
      game.broker = new AlpacaBroker({ keyId: env.ALPACA_PAPER_KEY_ID, secret: env.ALPACA_PAPER_SECRET, live: false });
      game.mode = 'paper'; game.metas = {}; game.day = { key: '', startEquity: null, trades: 0, halted: false };
      game.say('paper');
      return;
    }
    if (!(await game.command(cmd, args))) throw new Error('Unknown command: ' + cmd);
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const publicDir = path.join(__dirname, 'public');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', async () => {
        try {
          const { cmd, args } = JSON.parse(body || '{}');
          await command(cmd, args || {});
          broadcast('snapshot', snap()); save();
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = file === '/core.js' ? path.join(__dirname, 'core.js') : path.join(publicDir, path.normalize(file));
    if (file !== '/core.js' && !full.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });

  return new Promise((resolve, reject) => {
    const listen = (port) => {
      server.once('error', (e) => { if (e.code === 'EADDRINUSE' && port !== 0) listen(0); else reject(e); });
      // localhost only: your API keys never leave this machine
      server.listen(port, '127.0.0.1', () => {
        const p = server.address().port;
        loop();
        resolve({
          port: p, url: `http://127.0.0.1:${p}`, broker: broker.name, saveNow,
          close() { stopped = true; clearTimeout(loopTimer); saveNow(); for (const c of clients) c.end(); server.close(); },
        });
      });
    };
    listen(opts.port == null ? 3777 : opts.port);
  });
}

module.exports = { startServer, loadDotEnv };

// ---- command-line mode ----
if (require.main === module) {
  const env = Object.assign(loadDotEnv(path.join(__dirname, '.env')), process.env);
  startServer({ env, dataDir: path.join(__dirname, 'data'), port: +(env.PORT || 3777) }).then((s) => {
    console.log('\n  🤖  Trading agent arena running at  ' + s.url.replace('127.0.0.1', 'localhost'));
    console.log('      Broker: ' + s.broker + (env.ALPACA_PAPER_KEY_ID ? '' : '  (add Alpaca paper keys to .env to trade on Alpaca)'));
    console.log('      Live trading: ' + (env.ALLOW_LIVE === 'true' && env.ALPACA_LIVE_KEY_ID ? 'available once unlocked in-game' : 'disabled') + '\n');
    const bye = () => { s.close(); process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  });
}
