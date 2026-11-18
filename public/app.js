/* Trading Agent Arena — UI */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const usd = (n, sign) => (n == null || isNaN(n) ? '—' : (sign && n > 0 ? '+' : '') + (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const fmtPx = (p) => (p == null ? '—' : p >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(2) : p.toPrecision(4));
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const MOOD = {
    ecstatic: { c: '#ffc94d', label: 'ECSTATIC' }, happy: { c: '#3dffb5', label: 'HAPPY' }, focused: { c: '#5ee7ff', label: 'FOCUSED' },
    nervous: { c: '#ff9f5e', label: 'NERVOUS' }, grumpy: { c: '#ff4f8b', label: 'GRUMPY' }, sleepy: { c: '#8a8fc4', label: 'SLEEPY' },
    chill: { c: '#a77bff', label: 'CHILL' }, shaken: { c: '#ff4f8b', label: 'SHAKEN' },
  };

  // ---------------- backends ----------------
  class ServerBackend {
    constructor(onSnap, onEvent, onFail) {
      this.es = new EventSource('/api/stream');
      let gotOne = false;
      this.es.addEventListener('snapshot', (m) => { gotOne = true; onSnap(JSON.parse(m.data)); });
      this.es.addEventListener('event', (m) => onEvent(JSON.parse(m.data)));
      this.es.onerror = () => { if (!gotOne) { this.es.close(); onFail(); } };
    }
    async command(cmd, args) {
      const r = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, args }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || 'Command failed');
    }
  }
  class LocalBackend {
    constructor(onSnap, onEvent) {
      const C = window.AgentCore;
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('arena-demo') || '{}'); } catch (_) {}
      this.broker = new C.SimBroker(saved.sim);
      this.game = new C.Game({ broker: this.broker, state: saved.game, onEvent });
      this.game.running = false;
      this.speed = 1; this.onSnap = onSnap;
      const loop = async () => {
        await this.game.tick();
        this.push();
        try { localStorage.setItem('arena-demo', JSON.stringify({ game: this.game.toJSON(), sim: this.broker.toJSON() })); } catch (_) {}
        setTimeout(loop, 1000 / this.speed);
      };
      setTimeout(loop, 50);
    }
    push() { this.onSnap(Object.assign(this.game.snapshot(), { simSpeed: this.speed, isSim: true, liveAllowed: false, demo: true })); }
    async command(cmd, args) {
      if (cmd === 'speed') this.speed = Math.max(0.5, Math.min(10, +args.value || 1));
      else if (cmd === 'goLive' || cmd === 'goPaper') throw new Error('Run the app on your computer with Alpaca keys to trade for real.');
      else await this.game.command(cmd, args);
      this.push();
    }
  }

  // ---------------- state ----------------
  let S = null, backend = null, selected = null, seenEvents = new Set(), lastLevel = null, lastAch = null;
  const anim = { mood: 'chill', jiggle: 0, wave: 0, t: 0, blink: 0, flash: null, particles: [] };

  function start() {
    if (window.__DEMO__) { useLocal(); return; }
    backend = new ServerBackend(render, onEvent, () => useLocal());
  }
  function useLocal() { $('demoBanner').hidden = false; backend = new LocalBackend(render, onEvent); }

  async function cmd(c, args) {
    try { await backend.command(c, args || {}); }
    catch (e) { toast(e.message, 'warn'); throw e; }
  }

  // ---------------- events / fx ----------------
  function onEvent(e) {
    if (seenEvents.has(e.id)) return;
    seenEvents.add(e.id);
    if (e.type === 'say') speak(e.text);
    if (e.type === 'trade') {
      if (e.data.side === 'buy') { burst('#5ee7ff', 10); anim.wave = 1; }
      else if (e.data.pnl > 0) { burst('#ffc94d', 24, true); floatText('+' + usd(e.data.pnl).replace('$', '$'), '#3dffb5'); anim.jiggle = 1; }
      else { rain(); floatText(usd(e.data.pnl), '#ff4f8b'); }
    }
    if (e.type === 'achievement') toast('🏆 ' + e.text);
    if (e.type === 'level') { $('levelUpSub').textContent = e.text; const l = $('levelUp'); l.hidden = false; l.querySelectorAll('div,small').forEach((n) => { n.style.animation = 'none'; void n.offsetWidth; n.style.animation = ''; }); setTimeout(() => (l.hidden = true), 2300); burst('#a77bff', 40, true); }
    if (e.type === 'learn') burst('#a77bff', 12);
    if (e.type === 'warn') toast('⚠ ' + e.text, 'warn');
  }
  let typeTimer = null;
  function speak(text) {
    const b = $('bubble'), t = $('bubbleText');
    clearInterval(typeTimer);
    b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    let i = 0; t.textContent = '';
    typeTimer = setInterval(() => { t.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typeTimer); }, 18);
    anim.talk = Date.now() + Math.min(2500, text.length * 30);
  }
  function floatText(txt, color) {
    const d = document.createElement('div'); d.className = 'float'; d.textContent = txt; d.style.color = color;
    d.style.left = 40 + Math.random() * 40 + '%'; d.style.top = '55%';
    $('fx').appendChild(d); setTimeout(() => d.remove(), 1900);
  }
  function burst(color, n, coins) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 3.5;
      anim.particles.push({ x: 160, y: 150, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2.5, life: 1, color, coin: coins && Math.random() < 0.6, r: 2 + Math.random() * 3 });
    }
  }
  function rain() {
    anim.cloud = Date.now() + 2200;
    for (let i = 0; i < 26; i++) anim.particles.push({ x: 100 + Math.random() * 120, y: 40 + Math.random() * 20, vx: 0, vy: 2 + Math.random() * 2, life: 1, color: '#7aa2ff', drop: true, r: 2 });
  }
  function toast(text, kind) {
    const d = document.createElement('div'); d.className = 'toast' + (kind ? ' ' + kind : ''); d.textContent = text;
    $('toasts').appendChild(d); setTimeout(() => d.remove(), 4500);
  }

  // ---------------- agent canvas ----------------
  const cv = $('agentCanvas'), ctx = cv.getContext('2d');
  function setupCanvas(c, w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = w * dpr; c.height = h * dpr; c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  setupCanvas(cv, 320, 300);
  function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function drawAgent() {
    anim.t += 1 / 60;
    const t = anim.t, mood = anim.mood, mc = (MOOD[mood] || MOOD.chill).c;
    ctx.clearRect(0, 0, 320, 300);
    // floor grid
    ctx.save(); ctx.strokeStyle = mc + '33'; ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) { const y = 230 + i * i * 1.6; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(320, y); ctx.stroke(); }
    for (let i = -8; i <= 8; i++) { ctx.beginPath(); ctx.moveTo(160 + i * 12, 230); ctx.lineTo(160 + i * 60, 300); ctx.stroke(); }
    ctx.restore();
    // glow
    const g = ctx.createRadialGradient(160, 150, 10, 160, 150, 130); g.addColorStop(0, mc + '55'); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 300);

    const sleepy = mood === 'sleepy' || mood === 'chill';
    const bob = Math.sin(t * (sleepy ? 1.2 : 2.4)) * (sleepy ? 3 : 6);
    anim.jiggle *= 0.94; anim.wave *= 0.96;
    const jig = Math.sin(t * 40) * anim.jiggle * 6;
    const cx = 160 + jig, cy = 150 + bob;
    // shadow
    ctx.fillStyle = '#0008'; ctx.beginPath(); ctx.ellipse(160, 252, 58 - bob, 9, 0, 0, Math.PI * 2); ctx.fill();
    // thruster flame
    ctx.save(); const fl = 10 + Math.sin(t * 30) * 4 + (mood === 'ecstatic' ? 8 : 0);
    const fg = ctx.createLinearGradient(0, cy + 70, 0, cy + 70 + fl * 2); fg.addColorStop(0, mc); fg.addColorStop(1, 'transparent');
    ctx.fillStyle = fg; ctx.beginPath(); ctx.moveTo(cx - 14, cy + 70); ctx.lineTo(cx + 14, cy + 70); ctx.lineTo(cx, cy + 70 + fl * 2); ctx.closePath(); ctx.fill(); ctx.restore();
    // body
    ctx.fillStyle = '#2b3170'; rr(cx - 42, cy + 18, 84, 56, 20); ctx.fill();
    ctx.fillStyle = '#3a418f'; rr(cx - 42, cy + 18, 84, 22, 14); ctx.fill();
    // chest light = P&L today
    ctx.fillStyle = mc; ctx.shadowColor = mc; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(cx, cy + 48, 7, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    // arms
    const armA = Math.sin(t * 3) * 0.15 + anim.wave * Math.sin(t * 18) * 0.9;
    for (const s of [-1, 1]) {
      ctx.save(); ctx.translate(cx + s * 44, cy + 30); ctx.rotate(s * (0.5 + (s > 0 ? armA : -armA * 0.3)) + (mood === 'ecstatic' ? -s * 1.6 : 0));
      ctx.fillStyle = '#3a418f'; rr(-6, 0, 12, 38, 6); ctx.fill();
      ctx.fillStyle = mc; ctx.beginPath(); ctx.arc(0, 40, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    // antenna
    ctx.strokeStyle = '#8a8fc4'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, cy - 58); ctx.quadraticCurveTo(cx + Math.sin(t * 3) * 8, cy - 74, cx + Math.sin(t * 3) * 4, cy - 84); ctx.stroke();
    ctx.fillStyle = mc; ctx.shadowColor = mc; ctx.shadowBlur = 16 + Math.sin(t * 5) * 8; ctx.beginPath(); ctx.arc(cx + Math.sin(t * 3) * 4, cy - 86, 6, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    // head
    ctx.fillStyle = '#4a52b0'; rr(cx - 60, cy - 60, 120, 82, 26); ctx.fill();
    ctx.fillStyle = '#0b0d24'; rr(cx - 50, cy - 50, 100, 62, 18); ctx.fill();
    ctx.strokeStyle = mc + '88'; ctx.lineWidth = 2; rr(cx - 50, cy - 50, 100, 62, 18); ctx.stroke();
    // scanlines
    ctx.fillStyle = '#ffffff08'; for (let y = cy - 48; y < cy + 10; y += 4) ctx.fillRect(cx - 48, y, 96, 1);
    // face
    ctx.strokeStyle = mc; ctx.fillStyle = mc; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.shadowColor = mc; ctx.shadowBlur = 10;
    anim.blink -= 1 / 60; if (anim.blink < -3 - Math.random() * 3) anim.blink = 0.12;
    const blinking = anim.blink > 0;
    const ex = 22, ey = cy - 26;
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      ctx.beginPath();
      if (blinking || mood === 'sleepy') { ctx.moveTo(x - 8, ey + 2); ctx.lineTo(x + 8, ey + 2); ctx.stroke(); }
      else if (mood === 'ecstatic') { ctx.moveTo(x - 9, ey + 4); ctx.lineTo(x, ey - 5); ctx.lineTo(x + 9, ey + 4); ctx.stroke(); }
      else if (mood === 'chill') { ctx.moveTo(x - 8, ey); ctx.quadraticCurveTo(x, ey + 7, x + 8, ey); ctx.stroke(); }
      else if (mood === 'focused') { ctx.fillRect(x - 9, ey - 3, 18, 7); }
      else if (mood === 'shaken') { ctx.arc(x, ey, 8, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x, ey, 2.5, 0, Math.PI * 2); ctx.fill(); }
      else { const r = mood === 'nervous' ? 4 : 6; ctx.arc(x + (mood === 'nervous' ? Math.sin(t * 6) * 3 : 0), ey, r, 0, Math.PI * 2); ctx.fill(); }
      if (mood === 'grumpy') { ctx.beginPath(); ctx.moveTo(x - 10 * s, ey - 14); ctx.lineTo(x + 8 * s, ey - 8); ctx.stroke(); }
    }
    // mouth
    const my = cy - 2, talking = anim.talk && Date.now() < anim.talk;
    ctx.beginPath();
    if (talking) { const o = 3 + Math.abs(Math.sin(t * 18)) * 6; ctx.ellipse(cx, my, 9, o, 0, 0, Math.PI * 2); ctx.fill(); }
    else if (mood === 'ecstatic' || mood === 'happy') { ctx.arc(cx, my - 6, 12, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke(); }
    else if (mood === 'grumpy') { ctx.arc(cx, my + 8, 11, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke(); }
    else if (mood === 'nervous') { ctx.moveTo(cx - 12, my); for (let i = 0; i <= 6; i++) ctx.lineTo(cx - 12 + i * 4, my + (i % 2 ? 3 : -3)); ctx.stroke(); }
    else if (mood === 'shaken') { ctx.arc(cx, my, 5, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.moveTo(cx - 10, my); ctx.lineTo(cx + 10, my); ctx.stroke(); }
    ctx.shadowBlur = 0;
    // sweat
    if (mood === 'nervous' || mood === 'shaken') { ctx.fillStyle = '#7ad7ff'; const sy = cy - 50 + ((t * 30) % 30); ctx.beginPath(); ctx.ellipse(cx + 62, sy, 4, 6, 0, 0, Math.PI * 2); ctx.fill(); }
    // zzz
    if (mood === 'sleepy') { ctx.fillStyle = '#c9ccf5'; ctx.font = '700 16px ui-monospace, monospace'; for (let i = 0; i < 3; i++) { const p = (t * 0.5 + i / 3) % 1; ctx.globalAlpha = 1 - p; ctx.fillText('z', cx + 60 + p * 30, cy - 60 - p * 50); } ctx.globalAlpha = 1; }
    // rain cloud
    if (anim.cloud && Date.now() < anim.cloud) { ctx.fillStyle = '#5b6090'; for (const [dx, r] of [[-30, 18], [0, 24], [30, 18]]) { ctx.beginPath(); ctx.arc(160 + dx, 44, r, 0, Math.PI * 2); ctx.fill(); } }
    // particles
    anim.particles = anim.particles.filter((p) => p.life > 0);
    for (const p of anim.particles) {
      p.x += p.vx; p.y += p.vy; if (!p.drop) p.vy += 0.12; p.life -= p.drop ? 0.012 : 0.016;
      ctx.globalAlpha = Math.max(0, p.life);
      if (p.coin) { ctx.fillStyle = '#ffc94d'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 5 * Math.abs(Math.cos(p.life * 12)) + 1, 5, 0, 0, Math.PI * 2); ctx.fill(); }
      else if (p.drop) { ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 2, 7); }
      else { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(drawAgent);
  }
  requestAnimationFrame(drawAgent);
  cv.addEventListener('click', () => { anim.jiggle = 1; anim.wave = 1; burst('#5ee7ff', 8); cmd('poke').catch(() => {}); });

  // ---------------- chart ----------------
  const ch = $('chart'), cctx = ch.getContext('2d');
  function drawChart() {
    if (!S || !selected || !S.market[selected]) return;
    const w = ch.clientWidth || 800, h = ch.clientHeight || 280;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (ch.width !== Math.round(w * dpr)) { ch.width = Math.round(w * dpr); ch.height = Math.round(h * dpr); }
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, w, h);
    const bars = S.market[selected].bars || [];
    if (bars.length < 2) { cctx.fillStyle = '#8a8fc4'; cctx.font = '13px ui-monospace, monospace'; cctx.fillText(S.market[selected].error || 'Waiting for market data…', 16, 30); return; }
    const pos = S.positions.find((p) => p.symbol === selected && p.managed);
    let lo = Math.min(...bars.map((b) => b.l)), hi = Math.max(...bars.map((b) => b.h));
    let tp = null, sl = null;
    if (pos) { tp = pos.meta.entryPrice * (1 + S.settings.takeProfitPct); sl = pos.meta.entryPrice * (1 - S.settings.stopLossPct); lo = Math.min(lo, sl); hi = Math.max(hi, tp); }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const L = 8, R = 64, T = 10, B = 22, cw = (w - L - R) / bars.length;
    const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (h - T - B);
    // grid + labels
    cctx.strokeStyle = '#2a2f66'; cctx.fillStyle = '#8a8fc4'; cctx.font = '10px ui-monospace, monospace'; cctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const p = lo + (hi - lo) * i / 4, yy = y(p); cctx.beginPath(); cctx.moveTo(L, yy); cctx.lineTo(w - R, yy); cctx.stroke(); cctx.fillText(fmtPx(p), w - R + 6, yy + 3); }
    const t0 = new Date(bars[0].t), t1 = new Date(bars[bars.length - 1].t);
    cctx.fillText(t0.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), L, h - 6);
    const t1s = t1.toLocaleString([], { hour: '2-digit', minute: '2-digit' }); cctx.fillText(t1s, w - R - cctx.measureText(t1s).width, h - 6);
    // zones
    if (pos) {
      cctx.fillStyle = '#3dffb510'; cctx.fillRect(L, y(tp), w - L - R, y(pos.meta.entryPrice) - y(tp));
      cctx.fillStyle = '#ff4f8b10'; cctx.fillRect(L, y(pos.meta.entryPrice), w - L - R, y(sl) - y(pos.meta.entryPrice));
      for (const [p, c, lab] of [[tp, '#3dffb5', 'TP'], [pos.meta.entryPrice, '#5ee7ff', 'IN'], [sl, '#ff4f8b', 'SL']]) {
        cctx.strokeStyle = c; cctx.setLineDash([5, 4]); cctx.beginPath(); cctx.moveTo(L, y(p)); cctx.lineTo(w - R, y(p)); cctx.stroke(); cctx.setLineDash([]);
        cctx.fillStyle = c; cctx.fillText(lab, L + 4, y(p) - 3);
      }
    }
    // candles
    bars.forEach((b, i) => {
      const x = L + i * cw + cw / 2, up = b.c >= b.o, col = up ? '#3dffb5' : '#ff4f8b';
      cctx.strokeStyle = col; cctx.fillStyle = col; cctx.lineWidth = 1;
      cctx.beginPath(); cctx.moveTo(x, y(b.h)); cctx.lineTo(x, y(b.l)); cctx.stroke();
      const top = y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      cctx.globalAlpha = up ? 0.9 : 0.75; cctx.fillRect(x - Math.max(1, cw * 0.35), top, Math.max(2, cw * 0.7), bh); cctx.globalAlpha = 1;
    });
    // last price tag
    const last = bars[bars.length - 1].c, ly = y(last);
    cctx.fillStyle = '#5ee7ff'; cctx.fillRect(w - R + 2, ly - 8, R - 4, 16); cctx.fillStyle = '#05061a'; cctx.font = '700 10px ui-monospace, monospace'; cctx.fillText(fmtPx(last), w - R + 6, ly + 4);
    // trade markers
    const tStart = bars[0].t, tEnd = bars[bars.length - 1].t + 300000;
    for (const tr of S.trades.filter((x) => x.sym === selected && x.t >= tStart && x.t <= tEnd)) {
      let idx = 0, best = Infinity; bars.forEach((b, i) => { const d = Math.abs(b.t - tr.t); if (d < best) { best = d; idx = i; } });
      const x = L + idx * cw + cw / 2, b = bars[idx];
      cctx.beginPath();
      if (tr.side === 'buy') { const yy = y(b.l) + 8; cctx.fillStyle = '#5ee7ff'; cctx.moveTo(x, yy); cctx.lineTo(x - 6, yy + 10); cctx.lineTo(x + 6, yy + 10); }
      else { const yy = y(b.h) - 8; cctx.fillStyle = tr.pnl > 0 ? '#3dffb5' : '#ff4f8b'; cctx.moveTo(x, yy); cctx.lineTo(x - 6, yy - 10); cctx.lineTo(x + 6, yy - 10); }
      cctx.closePath(); cctx.shadowColor = cctx.fillStyle; cctx.shadowBlur = 8; cctx.fill(); cctx.shadowBlur = 0;
    }
  }
  window.addEventListener('resize', drawChart);

  function spark(c, bars) {
    const w = c.clientWidth || 140, h = 34, dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = w * dpr; c.height = h * dpr; const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = bars.slice(-50).map((b) => b.c); if (pts.length < 2) return;
    const lo = Math.min(...pts), hi = Math.max(...pts), up = pts[pts.length - 1] >= pts[0], col = up ? '#3dffb5' : '#ff4f8b';
    x.beginPath(); pts.forEach((p, i) => { const px = (i / (pts.length - 1)) * w, py = h - 3 - ((p - lo) / (hi - lo || 1)) * (h - 6); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.strokeStyle = col; x.lineWidth = 1.8; x.stroke();
    x.lineTo(w, h); x.lineTo(0, h); x.closePath(); const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, col + '44'); g.addColorStop(1, 'transparent'); x.fillStyle = g; x.fill();
  }

  // ---------------- render ----------------
  function render(s) {
    S = s;
    for (const e of s.events || []) if (!seenEvents.has(e.id)) { seenEvents.add(e.id); } // history: don't replay fx
    const a = s.agent;
    anim.mood = a.mood;
    if (lastLevel === null) { lastLevel = a.level; const said = (s.events || []).filter((e) => e.type === 'say').pop(); speak(said ? said.text : s.isSim && !s.demo ? `Hi! I'm ${a.name}. I'm on a practice simulator right now. Add your Alpaca paper keys in ⚙ and I'll trade the real market with fake money.` : `Hi! I'm ${a.name}. Press START and I'll go hunting for trades.`); }
    $('lvl').textContent = a.level; $('agentName').textContent = a.name; $('agentTitle').textContent = a.title;
    const span = a.xpNext - a.xpLevel; $('xpFill').style.width = Math.min(100, ((a.xp - a.xpLevel) / span) * 100) + '%';
    $('xpText').textContent = `${(a.xp - a.xpLevel).toLocaleString()} / ${span.toLocaleString()} XP`;
    $('equity').textContent = usd(s.account.equity);
    const dayP = s.day.startEquity ? s.account.equity - s.day.startEquity : 0;
    $('dayPnl').textContent = usd(dayP, true); $('dayPnl').className = cls(dayP);
    $('totPnl').textContent = usd(s.stats.pnl, true); $('totPnl').className = cls(s.stats.pnl);
    $('winRate').textContent = s.stats.trades ? Math.round((s.stats.wins / s.stats.trades) * 100) + '%' : '—';
    $('tradesToday').textContent = `${s.day.trades} / ${s.settings.maxTradesPerDay}`;
    const mp = $('modePill'); mp.textContent = s.mode === 'live' ? '⚡ LIVE' : s.mode === 'paper' ? 'PAPER' : (s.demo ? 'DEMO' : 'SIM'); mp.className = 'mode-pill ' + s.mode;
    const br = $('btnRun'); br.textContent = s.running ? '❚❚ PAUSE' : '▶ START'; br.classList.toggle('paused', s.running);
    $('clock').textContent = (s.isSim ? 'sim time ' : '') + new Date(s.now).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ' · ' + s.broker;
    // mood
    const m = MOOD[a.mood] || MOOD.chill; $('moodLabel').textContent = m.label; document.querySelector('.mood-dot').style.background = m.c; document.querySelector('.mood-dot').style.color = m.c;
    $('streak').textContent = a.streak >= 2 ? '🔥'.repeat(Math.min(5, a.streak)) + ' x' + a.streak : '';
    $('tBold').style.width = a.boldness * 100 + '%'; $('tPat').style.width = a.patience * 100 + '%'; $('tCur').style.width = a.curiosity * 100 + '%';
    // live gate
    $('liveReqs').innerHTML = s.live.reqs.map((r) => `<li class="${r.ok ? 'ok' : 'no'}"><span>${r.ok ? '✔' : '○'} ${esc(r.label)}</span><span>${esc(r.have)}</span></li>`).join('');
    const bl = $('btnLive');
    if (s.mode === 'live') { bl.disabled = false; bl.textContent = '↩ BACK TO PAPER'; bl.dataset.act = 'paper'; }
    else if (s.demo || s.isSim) { bl.disabled = true; bl.textContent = s.demo ? 'DEMO: NOT AVAILABLE' : 'ADD ALPACA KEYS FIRST'; }
    else { bl.disabled = !s.live.ok; bl.textContent = s.live.ok ? '⚡ GO LIVE' : '🔒 LOCKED'; bl.dataset.act = 'live'; }
    $('liveCap').textContent = usd(s.settings.liveMaxOrderUsd);
    const cb = $('connBanner');
    if (s.connError) {
      const bad = /forbidden|unauthorized|401|403|access key/i.test(s.connError);
      cb.hidden = false;
      cb.innerHTML = `<b>⚠ Can't reach ${esc(s.broker)}.</b> ${esc(s.connError)}<br>${bad ? 'Your API keys look wrong. Re-enter them in ⚙ Settings → Alpaca connection (paper keys start with PK).' : 'Check your internet connection. The agent will keep retrying.'}`;
    } else cb.hidden = true;
    renderWatchlist(); renderPositions(); renderDeck(); renderLogs(); renderAch(); drawChart();
    syncSettings();
  }

  function renderWatchlist() {
    const wl = S.settings.watchlist;
    if (!selected || !wl.includes(selected)) selected = wl[0];
    const box = $('watchlist');
    const keys = wl.join(',');
    if (box.dataset.keys !== keys) {
      box.dataset.keys = keys;
      box.innerHTML = wl.map((sym) => `<div class="card" data-sym="${esc(sym)}"><span class="badge" hidden></span><div class="sym">${esc(sym)}</div><div class="px"></div><canvas></canvas><div class="sig"></div></div>`).join('');
      box.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => { selected = c.dataset.sym; renderWatchlist(); drawChart(); }));
    }
    box.querySelectorAll('.card').forEach((c) => {
      const sym = c.dataset.sym, m = S.market[sym] || {}, bars = m.bars || [];
      c.classList.toggle('sel', sym === selected);
      const chg = bars.length > 1 ? (bars[bars.length - 1].c / bars[0].c - 1) * 100 : 0;
      c.querySelector('.px').innerHTML = `${fmtPx(m.price)} <span class="${cls(chg)} small">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`;
      spark(c.querySelector('canvas'), bars);
      const p = S.positions.find((x) => x.symbol === sym);
      const badge = c.querySelector('.badge');
      if (p && p.managed) { badge.hidden = false; badge.className = 'badge hold'; badge.textContent = 'HOLDING ' + usd(p.unrealizedPnl, true); }
      else if (p) { badge.hidden = false; badge.className = 'badge ext'; badge.textContent = 'YOURS'; }
      else if (m.open === false) { badge.hidden = false; badge.className = 'badge closed'; badge.textContent = 'CLOSED'; }
      else badge.hidden = true;
      c.querySelector('.sig').textContent = m.error ? '⚠ ' + m.error : m.signal ? `${m.signal.strat}: ${m.signal.reason}` : p && p.managed ? `via ${p.meta.strategy}` : 'scanning…';
    });
    const m = S.market[selected] || {};
    $('chartSym').textContent = selected || '—';
    $('chartInfo').textContent = m.open === false ? 'market closed' : '5-minute candles';
  }

  function renderPositions() {
    const ps = S.positions;
    if (!ps.length) { $('positions').innerHTML = '<div class="empty">Inventory empty. The agent is waiting for a setup it likes.</div>'; return; }
    $('positions').innerHTML = ps.map((p) => {
      const pct = p.avgPrice ? (p.price / p.avgPrice - 1) * 100 : 0;
      return `<div class="pos-row"><div><span class="lbl">${p.managed ? 'Agent' : 'Yours (untouched)'}</span><b>${esc(p.symbol)}</b></div>
        <div><span class="lbl">Value</span>${usd(p.marketValue)}</div>
        <div><span class="lbl">Entry → now</span>${fmtPx(p.avgPrice)} → ${fmtPx(p.price)}</div>
        <div><span class="lbl">P&amp;L</span><b class="${cls(p.unrealizedPnl)}">${usd(p.unrealizedPnl, true)} (${pct.toFixed(2)}%)</b></div>
        <div><span class="lbl">Strategy</span>${p.managed ? esc(p.meta.strategy || '?') : '—'}</div></div>`;
    }).join('');
  }

  function scard(s, top) {
    const tot = s.wins + s.losses, trust = Math.round(((s.wins + 1) / (s.trades + 2)) * 100);
    const params = Object.entries(s.params).map(([k, v]) => `${k} ${v}`).join(' · ');
    return `<div class="scard ${top ? 'top' : ''} ${s.retired ? 'retired' : ''}" title="${esc(s.blurb)}">
      <div class="sh"><span class="ico">${s.icon}</span><span>${esc(s.name)}</span><span class="gen ${s.gen > 1 ? '' : 'base'}">${s.gen > 1 ? 'MUTANT G' + s.gen : 'FOUNDER'}</span></div>
      <div class="wr">${tot ? `<div class="w" style="width:${(s.wins / tot) * 100}%"></div><div class="l" style="width:${(s.losses / tot) * 100}%"></div>` : ''}</div>
      <div class="smeta"><span>${s.wins}W · ${s.losses}L</span><span class="${cls(s.pnl)}">${usd(s.pnl, true)}</span><span class="trust">${top ? '★ ' : ''}trust ${trust}%</span></div>
      <div class="params">${esc(params)}</div></div>`;
  }
  function renderDeck() {
    const act = S.strategies.filter((s) => !s.retired).sort((a, b) => (b.wins + 1) / (b.trades + 2) - (a.wins + 1) / (a.trades + 2));
    const dead = S.strategies.filter((s) => s.retired).reverse();
    $('deck').innerHTML = act.map((s, i) => scard(s, i === 0 && s.trades > 0)).join('');
    $('grave').innerHTML = dead.length ? dead.map((s) => scard(s)).join('') : '<div class="empty">No fallen strategies yet.</div>';
    $('graveCount').textContent = dead.length ? `(${dead.length})` : '';
  }

  const ICON = { say: '💬', trade: '⚔', learn: '🧠', warn: '⚠', level: '⭐', achievement: '🏆', info: 'ℹ' };
  function renderLogs() {
    const t = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    $('tab-log').innerHTML = S.events.slice().reverse().map((e) => {
      const k = e.type === 'trade' ? (e.data.side === 'buy' ? 'buy' : e.data.pnl > 0 ? 'win' : 'loss') : '';
      return `<div class="ev ${e.type} ${k}"><time>${t(e.ts)}</time><span>${ICON[e.type] || '•'}</span><span>${esc(e.text)}</span></div>`;
    }).join('') || '<div class="empty">Press START to unleash the agent.</div>';
    $('tab-brain').innerHTML = S.journal.slice().reverse().map((j) => `<div class="ev learn"><time>${t(j.ts)}</time><span>${j.kind === 'experiment' ? '🧪' : j.kind === 'retire' ? '🪦' : '💡'}</span><span>${esc(j.text)}</span></div>`).join('') || '<div class="empty">Nothing learned yet. It needs a few trades to start forming opinions.</div>';
  }
  function renderAch() {
    const got = S.achievements.filter((a) => a.unlocked).length;
    $('achCount').textContent = `${got}/${S.achievements.length}`;
    $('tab-ach').innerHTML = S.achievements.map((a) => `<div class="achv ${a.unlocked ? 'got' : 'locked'}"><div class="ai">${a.icon}</div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div>`).join('');
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
    for (const id of ['log', 'brain', 'ach']) $('tab-' + id).hidden = id !== b.dataset.tab;
  }));

  // ---------------- controls ----------------
  $('btnRun').addEventListener('click', () => cmd(S && S.running ? 'pause' : 'start').catch(() => {}));
  let killArmed = null;
  $('btnKill').addEventListener('click', () => {
    const b = $('btnKill');
    if (!killArmed) { b.classList.add('armed'); b.textContent = 'CONFIRM?'; killArmed = setTimeout(() => { killArmed = null; b.classList.remove('armed'); b.textContent = '⏻ KILL'; }, 3000); return; }
    clearTimeout(killArmed); killArmed = null; b.classList.remove('armed'); b.textContent = '⏻ KILL';
    cmd('kill').catch(() => {});
  });
  const openModal = (id) => { $(id).hidden = false; }, closeModal = (el) => { el.closest('.modal').hidden = true; };
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b)));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));
  $('btnSettings').addEventListener('click', () => { if (window.desktop) refreshDesk(); $('nameInput').value = S ? S.agent.name : ''; settingsBuilt = false; syncSettings(); openModal('settingsModal'); });
  $('btnRename').addEventListener('click', () => cmd('rename', { name: $('nameInput').value }).catch(() => {}));
  $('btnAddSym').addEventListener('click', () => { const v = $('symInput').value; $('symInput').value = ''; cmd('addSymbol', { symbol: v }).catch(() => {}); });
  $('symInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddSym').click(); });
  $('speed').addEventListener('input', (e) => { $('speedVal').textContent = e.target.value + '×'; cmd('speed', { value: e.target.value }).catch(() => {}); });
  $('btnLive').addEventListener('click', () => {
    if ($('btnLive').dataset.act === 'paper') { cmd('goPaper').catch(() => {}); return; }
    $('liveErr').textContent = ''; $('liveConfirm').value = ''; openModal('liveModal');
  });
  $('btnLiveConfirm').addEventListener('click', async () => {
    try { await backend.command('goLive', { confirm: $('liveConfirm').value }); $('liveModal').hidden = true; }
    catch (e) { $('liveErr').textContent = e.message; }
  });

  const RISK = [
    ['maxPositionPct', 'Max size per trade', 0.01, 0.25, 0.01, 'pct'],
    ['maxOrderUsd', 'Max $ per trade (paper)', 10, 10000, 10, 'usd'],
    ['liveMaxOrderUsd', 'Max $ per trade (LIVE)', 1, 500, 1, 'usd'],
    ['maxOpenPositions', 'Max open positions', 1, 10, 1, 'n'],
    ['stopLossPct', 'Stop-loss', 0.005, 0.1, 0.005, 'pct'],
    ['takeProfitPct', 'Take-profit', 0.005, 0.2, 0.005, 'pct'],
    ['dailyLossLimitPct', 'Daily loss limit', 0.005, 0.1, 0.005, 'pct'],
    ['maxTradesPerDay', 'Max trades per day', 1, 200, 1, 'n'],
    ['maxHoldMinutes', 'Max hold time (min)', 15, 2880, 15, 'n'],
  ];
  let settingsBuilt = false;
  function fmtSetting(v, kind) { return kind === 'pct' ? (v * 100).toFixed(1) + '%' : kind === 'usd' ? '$' + v : String(v); }
  function syncSettings() {
    if (!S) return;
    $('speedField').hidden = !S.isSim;
    $('wlEdit').innerHTML = S.settings.watchlist.map((s) => `<span class="chip">${esc(s)}<button data-rm="${esc(s)}" title="Remove">✕</button></span>`).join('');
    $('wlEdit').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => cmd('removeSymbol', { symbol: b.dataset.rm }).catch(() => {})));
    if (settingsBuilt) return;
    settingsBuilt = true;
    $('riskFields').innerHTML = RISK.map(([k, label, min, max, step, kind]) => `<div class="field"><label>${label} <b id="v-${k}">${fmtSetting(S.settings[k], kind)}</b></label><input type="range" data-k="${k}" data-kind="${kind}" min="${min}" max="${max}" step="${step}" value="${S.settings[k]}"></div>`).join('');
    $('riskFields').querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => { $('v-' + inp.dataset.k).textContent = fmtSetting(+inp.value, inp.dataset.kind); });
      inp.addEventListener('change', () => cmd('setting', { key: inp.dataset.k, value: inp.value }).catch(() => {}));
    });
    $('speed').value = S.simSpeed; $('speedVal').textContent = S.simSpeed + '×';
  }


  // ---------------- desktop app integration ----------------
  const D = window.desktop;
  let deskInfo = null;
  async function refreshDesk() {
    if (!D) return;
    deskInfo = await D.info();
    $('deskConn').hidden = false; $('deskUpd').hidden = false;
    const k = deskInfo.keys;
    $('connStatus').innerHTML = k.paper ? '<span class="ok-text">● paper connected</span>' + (k.live ? ' · live keys saved' + (k.allowLive ? '' : ' (Go Live off)') : '') : '· not connected (simulator)';
    $('kPaperId').placeholder = k.paper ? 'saved · leave blank to keep' : 'PK...';
    $('kPaperSecret').placeholder = k.paper ? 'saved · leave blank to keep' : '••••••••';
    $('kLiveId').placeholder = k.live ? 'saved · leave blank to keep' : 'AK...';
    $('kLiveSecret').placeholder = k.live ? 'saved · leave blank to keep' : '••••••••';
    $('kAllowLive').checked = k.allowLive;
    $('btnClearPaper').hidden = !k.paper; $('btnClearLive').hidden = !k.live;
    $('verLabel').textContent = 'v' + deskInfo.version;
    if (document.activeElement !== $('updRepo')) $('updRepo').value = deskInfo.updateRepo || '';
    renderUpdate(deskInfo.update);
  }
  function renderUpdate(u) {
    if (!D || !u) return;
    const chip = $('updChip'), st = $('updStatus');
    const msg = {
      idle: 'Waiting to check…', checking: 'Checking for updates…',
      current: '✔ You have the latest version.' + (u.checkedAt ? ' Checked ' + new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.' : ''),
      downloading: `⬇ Downloading v${u.version}… ${u.percent || 0}% (the agent keeps running)`,
      ready: `✨ v${u.version} is downloaded. Restart to install it. Your progress and keys are kept.` + (u.notes ? '\nWhat\'s new: ' + u.notes : ''),
      error: '⚠ ' + (u.message || 'Update check failed'),
      'not-configured': 'Updates are off until an update source is set below.',
      dev: u.message, unavailable: u.message,
    }[u.state] || '';
    st.textContent = msg; st.style.whiteSpace = 'pre-line';
    $('btnInstallUpd').hidden = u.state !== 'ready';
    if (u.state === 'downloading') { chip.hidden = false; chip.className = 'upd-chip'; chip.textContent = `⬇ UPDATING ${u.percent || 0}%`; }
    else if (u.state === 'ready') { chip.hidden = false; chip.className = 'upd-chip ready'; chip.textContent = `✨ v${u.version} READY · RESTART`; }
    else chip.hidden = true;
    if (u.state === 'ready' && !renderUpdate.told) { renderUpdate.told = true; toast(`✨ Update v${u.version} downloaded. Restart whenever you're ready.`); }
  }
  async function installUpdate() {
    if (S && S.running) speak('Installing an update. I\'ll be back in a few seconds, paused and safe.');
    setTimeout(() => D.installUpdate(), 800);
  }
  if (D) {
    D.onUpdate(renderUpdate);
    refreshDesk();
    $('updChip').addEventListener('click', () => { if (deskInfo && $('updChip').classList.contains('ready')) installUpdate(); else openModal('settingsModal'); });
    $('btnInstallUpd').addEventListener('click', installUpdate);
    $('btnCheckUpd').addEventListener('click', async () => { renderUpdate(await D.checkForUpdates()); });
    $('btnOpenData').addEventListener('click', () => D.openDataFolder());
    $('btnSaveRepo').addEventListener('click', async () => {
      try { await D.setUpdateRepo($('updRepo').value); toast('Update source saved'); refreshDesk(); } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'warn'); }
    });
    const saveKeys = async (extra) => {
      const k = Object.assign({ paperId: $('kPaperId').value, paperSecret: $('kPaperSecret').value, liveId: $('kLiveId').value, liveSecret: $('kLiveSecret').value, allowLive: $('kAllowLive').checked }, extra || {});
      if ((k.paperId && !k.paperSecret && !deskInfo.keys.paper) || (!k.paperId && k.paperSecret && !deskInfo.keys.paper)) { $('keysMsg').textContent = 'Enter both the key ID and the secret.'; return; }
      $('keysMsg').textContent = ''; $('btnSaveKeys').textContent = 'Reconnecting…'; $('btnSaveKeys').disabled = true;
      await D.saveKeys(k);
    };
    $('btnSaveKeys').addEventListener('click', () => saveKeys());
    $('btnClearPaper').addEventListener('click', () => saveKeys({ paperId: '', paperSecret: '', clearPaper: true }));
    $('btnClearLive').addEventListener('click', () => saveKeys({ liveId: '', liveSecret: '', clearLive: true, allowLive: false }));
  }

  start();
})();
