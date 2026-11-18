/*
 * AgentCore — the trading agent's brain, personality, risk manager and game engine.
 * Runs in Node (server.js) and in the browser (demo mode). No dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- helpers ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const fmtUsd = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  const isCrypto = (sym) => sym.includes('/');
  const uid = () => Math.random().toString(36).slice(2, 9);
  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // Beta sample via two gamma samples (Marsaglia–Tsang)
  function gamma(k) {
    if (k < 1) return gamma(k + 1) * Math.pow(Math.random(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = gauss(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  const betaSample = (a, b) => { const x = gamma(a); return x / (x + gamma(b)); };

  // ---------- indicators ----------
  const sma = (a, n) => { if (a.length < n) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; };
  const std = (a, n) => { const m = sma(a, n); if (m == null) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / n); };
  function rsi(a, n) {
    if (a.length < n + 1) return null;
    let g = 0, l = 0;
    for (let i = a.length - n; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
    if (l === 0) return 100;
    const rs = (g / n) / (l / n);
    return 100 - 100 / (1 + rs);
  }
  const highest = (a, n, skip = 0) => Math.max(...a.slice(-(n + skip), skip ? -skip : undefined));
  const lowest = (a, n, skip = 0) => Math.min(...a.slice(-(n + skip), skip ? -skip : undefined));

  // ---------- strategy types ----------
  // Each type: signal(closes, params, holding) -> {action, confidence, reason}
  const STRATEGY_TYPES = {
    momentum: {
      label: 'Trend Rider', icon: '🌊',
      blurb: 'Rides the wave when the fast average crosses above the slow one.',
      defaults: { fast: 8, slow: 21 },
      ranges: { fast: [3, 20], slow: [10, 60] },
      fix(p) { if (p.fast >= p.slow) p.slow = p.fast + 5; return p; },
      signal(c, p) {
        const f = sma(c, p.fast), s = sma(c, p.slow); if (f == null || s == null) return hold('warming up');
        const prevF = sma(c.slice(0, -1), p.fast), prevS = sma(c.slice(0, -1), p.slow);
        const px = c[c.length - 1];
        const gap = (f - s) / s;
        if (f > s && px > f) return { action: 'buy', confidence: clamp(0.4 + gap * 120 + (prevF <= prevS ? 0.25 : 0), 0, 1), reason: `fast avg above slow (${(gap * 100).toFixed(2)}%)` };
        if (f < s) return { action: 'sell', confidence: clamp(0.5 - gap * 100, 0, 1), reason: 'trend flipped down' };
        return hold('no clear trend');
      },
    },
    meanrev: {
      label: 'Rubber Band', icon: '🪀',
      blurb: 'Buys when price is stretched too far down (low RSI), sells when it snaps back.',
      defaults: { period: 14, low: 30, high: 62 },
      ranges: { period: [5, 28], low: [15, 40], high: [52, 80] },
      fix(p) { return p; },
      signal(c, p) {
        const r = rsi(c, p.period); if (r == null) return hold('warming up');
        if (r < p.low) return { action: 'buy', confidence: clamp(0.45 + (p.low - r) / 25, 0, 1), reason: `RSI ${r.toFixed(0)} is oversold` };
        if (r > p.high) return { action: 'sell', confidence: clamp(0.5 + (r - p.high) / 30, 0, 1), reason: `RSI ${r.toFixed(0)} snapped back` };
        return hold(`RSI ${r.toFixed(0)} neutral`);
      },
    },
    breakout: {
      label: 'Breakout Hunter', icon: '🚀',
      blurb: 'Pounces when price breaks above its recent high.',
      defaults: { lookback: 20, exit: 10 },
      ranges: { lookback: [8, 50], exit: [4, 25] },
      fix(p) { if (p.exit >= p.lookback) p.exit = Math.max(3, Math.floor(p.lookback / 2)); return p; },
      signal(c, p) {
        if (c.length < p.lookback + 2) return hold('warming up');
        const px = c[c.length - 1];
        const hi = highest(c, p.lookback, 1), lo = lowest(c, p.exit, 1);
        if (px > hi) return { action: 'buy', confidence: clamp(0.5 + ((px - hi) / hi) * 150, 0, 1), reason: `broke ${p.lookback}-bar high` };
        if (px < lo) return { action: 'sell', confidence: 0.7, reason: `fell below ${p.exit}-bar low` };
        return hold('inside range');
      },
    },
    bollinger: {
      label: 'Band Bouncer', icon: '🎯',
      blurb: 'Buys under the lower Bollinger band, exits back at the middle.',
      defaults: { period: 20, k: 2 },
      ranges: { period: [10, 40], k: [1.2, 3] },
      fix(p) { p.k = Math.round(p.k * 10) / 10; return p; },
      signal(c, p) {
        const m = sma(c, p.period), sd = std(c, p.period); if (m == null) return hold('warming up');
        const px = c[c.length - 1], lower = m - p.k * sd;
        if (px < lower) return { action: 'buy', confidence: clamp(0.45 + (lower - px) / (sd || 1) * 0.3, 0, 1), reason: 'below lower band' };
        if (px > m) return { action: 'sell', confidence: 0.6, reason: 'back to the middle band' };
        return hold('inside bands');
      },
    },
  };
  function hold(reason) { return { action: 'hold', confidence: 0, reason }; }

  // ---------- brain (learning) ----------
  class Brain {
    constructor(data) {
      this.strategies = (data && data.strategies) || Object.keys(STRATEGY_TYPES).map((t) => newStrategy(t, { ...STRATEGY_TYPES[t].defaults }, 1));
      this.journal = (data && data.journal) || [];
      this.closedSinceEvolve = (data && data.closedSinceEvolve) || 0;
      this.genCounter = (data && data.genCounter) || {};
    }
    toJSON() { return { strategies: this.strategies, journal: this.journal.slice(-60), closedSinceEvolve: this.closedSinceEvolve, genCounter: this.genCounter }; }
    active() { return this.strategies.filter((s) => !s.retired); }
    get(id) { return this.strategies.find((s) => s.id === id); }

    // Thompson sampling: draw a plausible win-rate for each strategy, pick the best.
    choose(symbol) {
      let best = null, bestScore = -1;
      for (const s of this.active()) {
        const sym = s.bySymbol[symbol] || { w: 0, l: 0 };
        const a = 1 + s.wins * 0.5 + sym.w, b = 1 + s.losses * 0.5 + sym.l;
        const score = betaSample(a, b);
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return best;
    }

    record(stratId, symbol, pnl, pct) {
      const s = this.get(stratId); if (!s) return [];
      const win = pnl > 0;
      s.trades++; s.pnl += pnl; win ? s.wins++ : s.losses++;
      const sym = (s.bySymbol[symbol] = s.bySymbol[symbol] || { w: 0, l: 0, pnl: 0 });
      win ? sym.w++ : sym.l++; sym.pnl += pnl;
      s.lastPct = pct;
      this.closedSinceEvolve++;
      const insights = [];
      if ([5, 10, 20, 40, 80].includes(s.trades)) {
        const wr = s.wins / s.trades;
        if (wr >= 0.6) insights.push(this.note(`${s.name} is working: ${s.wins}W-${s.losses}L. I'll lean on it more.`, 'insight'));
        else if (wr <= 0.35) insights.push(this.note(`${s.name} keeps losing (${s.wins}W-${s.losses}L). I'll use it less.`, 'insight'));
        else insights.push(this.note(`${s.name} is a coin flip so far (${s.wins}W-${s.losses}L). Still studying it.`, 'insight'));
      }
      const tot = sym.w + sym.l;
      if (tot === 4) {
        if (sym.w >= 3) insights.push(this.note(`${s.name} seems to fit ${symbol} well.`, 'insight'));
        if (sym.l >= 3) insights.push(this.note(`${s.name} doesn't fit ${symbol}. Noted.`, 'insight'));
      }
      return insights;
    }

    // Experiments: mutate a promising strategy into a new variant; retire losers.
    maybeEvolve(curiosity) {
      const out = [];
      if (this.closedSinceEvolve < 8) return out;
      if (Math.random() > 0.35 + curiosity * 0.5) return out;
      this.closedSinceEvolve = 0;
      const ranked = this.active().map((s) => ({ s, m: (s.wins + 1) / (s.trades + 2) })).sort((a, b) => b.m - a.m);
      const parent = Math.random() < 0.6 ? ranked[0].s : pick(ranked.slice(0, 4)).s;
      const T = STRATEGY_TYPES[parent.type];
      const p = {};
      for (const k of Object.keys(parent.params)) {
        const [lo, hi] = T.ranges[k];
        let v = parent.params[k] * (1 + gauss() * 0.25);
        v = clamp(v, lo, hi);
        p[k] = Number.isInteger(T.defaults[k]) ? Math.round(v) : Math.round(v * 10) / 10;
      }
      T.fix(p);
      this.genCounter[parent.type] = (this.genCounter[parent.type] || 1) + 1;
      const child = newStrategy(parent.type, p, this.genCounter[parent.type], parent.id);
      this.strategies.push(child);
      out.push({ kind: 'experiment', strat: child, parent, text: this.note(`Experiment: spawned ${child.name} from ${parent.name} (${paramStr(p)}).`, 'experiment').text });
      // prune
      // founders (gen 1) are never retired, so the agent always keeps its basic toolkit.
      // Mutants that lose get retired; if the roster is over the cap, the weakest mutant goes.
      const score = (s) => (s.wins + 1) / (s.trades + 2) + (s.pnl > 0 ? 0.05 : 0);
      for (;;) {
        const act = this.active();
        const mutants = act.filter((s) => s.gen > 1 && s.id !== child.id);
        const loser = mutants.filter((s) => s.trades >= 8 && s.wins / s.trades < 0.45 && s.pnl < 0).sort((a, b) => a.pnl - b.pnl)[0];
        const victim = loser || (act.length > 8 ? mutants.slice().sort((a, b) => score(a) - score(b) || a.born - b.born)[0] : null);
        if (!victim) break;
        victim.retired = true;
        out.push({ kind: 'retire', strat: victim, text: this.note(`Retired ${victim.name} (${victim.wins}W-${victim.losses}L, ${fmtUsd(victim.pnl)}). It didn't earn its spot.`, 'retire').text });
        if (!loser && this.active().length <= 8) break;
      }
      // keep the graveyard small
      const dead = this.strategies.filter((s) => s.retired);
      if (dead.length > 8) { const drop = new Set(dead.slice(0, dead.length - 8).map((s) => s.id)); this.strategies = this.strategies.filter((s) => !drop.has(s.id)); }
      return out;
    }
    note(text, kind) { const e = { ts: Date.now(), text, kind }; this.journal.push(e); if (this.journal.length > 80) this.journal.shift(); return e; }
  }
  function paramStr(p) { return Object.entries(p).map(([k, v]) => `${k} ${v}`).join(', '); }
  function newStrategy(type, params, gen, parentId) {
    const T = STRATEGY_TYPES[type];
    return { id: uid(), type, name: gen > 1 ? `${T.label} Mk${gen}` : T.label, icon: T.icon, params, gen, parentId: parentId || null, born: Date.now(), trades: 0, wins: 0, losses: 0, pnl: 0, bySymbol: {}, retired: false };
  }

  // ---------- personality ----------
  const LINES = {
    start: ['Booting up. Coffee.exe loaded. Let\'s find some trades.', 'Systems green. I\'m hunting.', 'Alright, {name} is on the clock.'],
    pause: ['Taking a breather. I\'ll keep watching the charts.', 'Paused. Hands off the keyboard.', 'Standing by.'],
    buy: ['Going in on {sym}. {strat} says {reason}.', 'Buying {sym}: {reason}. Let\'s see if I\'m right.', '{sym} looks juicy. {strat} pulled the trigger.', 'Small bite of {sym}. {reason}.'],
    win: ['Sold {sym} for {pnl}. Too easy.', 'Cha-ching! {pnl} on {sym}.', '{pnl} on {sym}. {strat} gets a gold star.', 'Banked {pnl}. I\'m learning, I\'m earning.'],
    bigwin: ['WOW. {pnl} on {sym}! Somebody frame this chart.', 'That\'s a monster: {pnl} on {sym}!'],
    loss: ['Lost {pnl} on {sym}. Writing that one down.', 'Ouch, {sym} bit me for {pnl}. Lesson logged.', '{strat} whiffed on {sym}. It\'s data.', 'Small loss on {sym} ({pnl}). Moving on.'],
    stop: ['Stop-loss hit on {sym}. Discipline > ego.', 'Cut {sym} at the stop. Live to trade another day.'],
    tp: ['Take-profit on {sym}! Locked in {pnl}.', 'Target hit on {sym}. Pocketing {pnl}.'],
    experiment: ['New idea! Testing {strat}.', 'I tweaked some knobs. Meet {strat}.', 'Science time: {strat} enters the arena.'],
    retire: ['Goodbye, {strat}. You were... not great.', '{strat} has been retired. No hard feelings.'],
    levelup: ['LEVEL {level}! I can feel my neurons multiplying.', 'Level {level} unlocked. Watch this.', 'Ding! Level {level}.'],
    achievement: ['Achievement unlocked: {ach}!'],
    idle: ['Watching the tape...', 'Nothing worth my money right now. Patience.', 'The market is thinking. So am I.', 'Scanning {sym}... meh.', 'Waiting for a setup. Bored but disciplined.'],
    sleepy: ['Stock market\'s closed. Crypto never sleeps though.', 'Zzz... wake me when the bell rings.'],
    halted: ['Daily loss limit hit. I\'m benching myself for today.', 'Risk limit reached. No more trades today. Rules are rules.'],
    kill: ['KILL SWITCH! Closing everything and powering down.', 'Emergency stop. All positions closed.'],
    poke: ['Hey! I\'m working here.', 'Boop. Yes, I\'m alive.', 'Did you know I\'ve made {trades} trades?', 'My favorite strategy right now is {fav}.', 'Pet the robot, get the gains. That\'s not real advice.', 'Boldness at {bold}%. Feeling {mood}.', 'Poke me again and I\'m buying meme coins. (I\'m not.)'],
    golive: ['REAL MONEY MODE. Tiny sizes, tight stops. I won\'t let you down.', 'Live trading engaged. My hands are... metaphorically shaking.'],
    paper: ['Back to paper money. Safe practice time.'],
    warn: ['Hmm, something glitched: {msg}'],
    streak: ['{n} wins in a row! I\'m on fire! 🔥', 'Streak x{n}! Don\'t jinx it.'],
  };
  function fill(t, v) { return t.replace(/\{(\w+)\}/g, (_, k) => (v[k] !== undefined ? v[k] : '')); }

  const ACHIEVEMENTS = [
    { id: 'first_trade', name: 'First Blood', icon: '🩸', desc: 'Make your first trade', test: (g) => g.stats.trades >= 1 },
    { id: 'first_win', name: 'In the Green', icon: '💚', desc: 'Close a winning trade', test: (g) => g.stats.wins >= 1 },
    { id: 'streak3', name: 'Hat Trick', icon: '🎩', desc: '3 wins in a row', test: (g) => g.agent.bestStreak >= 3 },
    { id: 'streak5', name: 'Unstoppable', icon: '🔥', desc: '5 wins in a row', test: (g) => g.agent.bestStreak >= 5 },
    { id: 'trades10', name: 'Getting Reps', icon: '🏋️', desc: '10 trades closed', test: (g) => g.stats.trades >= 10 },
    { id: 'trades50', name: 'Veteran', icon: '🎖️', desc: '50 trades closed', test: (g) => g.stats.trades >= 50 },
    { id: 'scientist', name: 'Mad Scientist', icon: '🧪', desc: 'Invent a strategy variant', test: (g) => g.brain.strategies.some((s) => s.gen > 1) },
    { id: 'darwin', name: 'Survival of the Fittest', icon: '🦖', desc: 'Retire a losing strategy', test: (g) => g.brain.strategies.some((s) => s.retired) },
    { id: 'profit100', name: 'Benjamin', icon: '💵', desc: '$100 total profit', test: (g) => g.stats.pnl >= 100 },
    { id: 'profit1000', name: 'Big Stack', icon: '💰', desc: '$1,000 total profit', test: (g) => g.stats.pnl >= 1000 },
    { id: 'resilient', name: 'Thick Skin', icon: '🛡️', desc: 'Win right after 3 losses in a row', test: (g) => g.agent.comeback },
    { id: 'diversified', name: 'Spread Out', icon: '🌐', desc: 'Hold 3 positions at once', test: (g) => g.agent.maxConcurrent >= 3 },
    { id: 'live', name: 'Real Deal', icon: '⚡', desc: 'Go live with real money', test: (g) => g.mode === 'live' },
  ];

  const xpForLevel = (L) => Math.round(40 * Math.pow(L - 1, 2.2)); // cumulative XP to reach level L
  const levelFromXp = (xp) => { let L = 1; while (xpForLevel(L + 1) <= xp) L++; return L; };
  const TITLES = ['Rookie', 'Rookie', 'Apprentice', 'Chart Reader', 'Tape Watcher', 'Swing Pro', 'Market Ninja', 'Quant Wizard', 'Legend', 'Oracle', 'Mythic'];

  const DEFAULT_SETTINGS = {
    watchlist: ['BTC/USD', 'ETH/USD', 'AAPL', 'NVDA', 'SPY'],
    maxPositionPct: 0.08,   // of equity per trade
    maxOrderUsd: 2000,      // per trade cap (paper/sim)
    liveMaxOrderUsd: 25,    // per trade cap when live
    maxOpenPositions: 4,
    dailyLossLimitPct: 0.03,
    maxTradesPerDay: 40,
    stopLossPct: 0.02,
    takeProfitPct: 0.035,
    maxHoldMinutes: 240,
    cooldownMinutes: 15,
  };

  // ---------- simulated market (demo / no keys) ----------
  class SimBroker {
    constructor(data) {
      this.name = 'Simulator'; this.mode = 'sim';
      const d = data || {};
      this.cash = d.cash != null ? d.cash : 100000;
      this.positions = d.positions || {}; // sym -> {qty, avg}
      this.markets = d.markets || {};
      this.t = d.t || Date.now();
    }
    toJSON() { return { cash: this.cash, positions: this.positions, markets: this.markets, t: this.t }; }
    seed(sym) {
      if (this.markets[sym]) return;
      const base = { 'BTC/USD': 95000, 'ETH/USD': 3400, 'SOL/USD': 180, 'DOGE/USD': 0.3, AAPL: 230, NVDA: 140, SPY: 590, TSLA: 260, MSFT: 420, AMZN: 210 }[sym] || 20 + Math.random() * 200;
      const m = { price: base, regime: 'chop', regimeLeft: 30, vol: isCrypto(sym) ? 0.006 : 0.0035, bars: [] };
      this.markets[sym] = m;
      for (let i = 0; i < 150; i++) this.step(sym, this.t - (150 - i) * 300000);
    }
    step(sym, t) {
      const m = this.markets[sym];
      if (--m.regimeLeft <= 0) { m.regime = pick(['up', 'down', 'chop', 'chop', 'up']); m.regimeLeft = 20 + Math.floor(Math.random() * 60); }
      const drift = m.regime === 'up' ? m.vol * 0.35 : m.regime === 'down' ? -m.vol * 0.3 : 0;
      const anchor = m.anchor || m.price; m.anchor = anchor * 0.995 + m.price * 0.005;
      const pull = m.regime === 'chop' ? (anchor - m.price) / m.price * 0.15 : 0;
      const o = m.price;
      const r = drift + pull + gauss() * m.vol;
      const c = Math.max(0.0001, o * (1 + r));
      const h = Math.max(o, c) * (1 + Math.abs(gauss()) * m.vol * 0.4);
      const l = Math.min(o, c) * (1 - Math.abs(gauss()) * m.vol * 0.4);
      m.price = c;
      m.bars.push({ t, o, h, l, c, v: Math.round(1000 + Math.random() * 5000) });
      if (m.bars.length > 300) m.bars.shift();
    }
    advance(watchlist) { this.t += 300000; for (const s of watchlist) { this.seed(s); this.step(s, this.t); } }
    now() { return this.t; }
    async isOpen() { return true; }
    async getBars(sym, n) { this.seed(sym); return this.markets[sym].bars.slice(-n); }
    async getAccount() {
      let mv = 0;
      for (const [s, p] of Object.entries(this.positions)) mv += p.qty * (this.markets[s] ? this.markets[s].price : p.avg);
      return { equity: this.cash + mv, cash: this.cash, buyingPower: this.cash };
    }
    async getPositions() {
      return Object.entries(this.positions).map(([symbol, p]) => {
        const px = this.markets[symbol] ? this.markets[symbol].price : p.avg;
        return { symbol, qty: p.qty, avgPrice: p.avg, price: px, marketValue: p.qty * px, unrealizedPnl: (px - p.avg) * p.qty };
      });
    }
    async buyNotional(sym, usd) {
      this.seed(sym);
      const px = this.markets[sym].price * 1.0005; // a little slippage
      const qty = usd / px;
      if (usd > this.cash) throw new Error('not enough cash');
      this.cash -= usd;
      const p = this.positions[sym];
      if (p) { p.avg = (p.avg * p.qty + px * qty) / (p.qty + qty); p.qty += qty; } else this.positions[sym] = { qty, avg: px };
      return { price: px, qty };
    }
    async closePosition(sym) {
      const p = this.positions[sym]; if (!p) return { pnl: 0 };
      const px = this.markets[sym].price * 0.9995;
      this.cash += p.qty * px;
      delete this.positions[sym];
      return { price: px, pnl: (px - p.avg) * p.qty };
    }
  }

  // ---------- the game engine ----------
  class Game {
    constructor(opts) {
      const s = opts.state || {};
      this.broker = opts.broker;
      this.mode = opts.broker.mode;
      this.onEvent = opts.onEvent || (() => {});
      this.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
      this.brain = new Brain(s.brain);
      this.agent = Object.assign({ name: 'Byte', xp: 0, boldness: 0.5, patience: 0.5, curiosity: 0.6, streak: 0, lossStreak: 0, bestStreak: 0, comeback: false, maxConcurrent: 0 }, s.agent || {});
      this.stats = Object.assign({ trades: 0, wins: 0, pnl: 0, modes: {} }, s.stats || {});
      this.achievements = s.achievements || {};
      this.metas = s.metas || {}; // symbol -> {strategyId, entryPrice, openedAt, qty}
      this.cooldowns = s.cooldowns || {};
      this.trades = s.trades || []; // recent trade markers
      this.day = s.day || { key: '', startEquity: null, trades: 0, halted: false };
      this.events = [];
      this.running = s.running !== undefined ? s.running : false;
      this.market = {}; // sym -> {bars, open, signal}
      this.account = { equity: 0, cash: 0 };
      this.positions = [];
      this.lastSay = 0;
      this.busy = false;
      this.liveAvailable = !!opts.liveAvailable;
    }

    toJSON() {
      return { settings: this.settings, brain: this.brain.toJSON(), agent: this.agent, stats: this.stats, achievements: this.achievements, metas: this.metas, cooldowns: this.cooldowns, trades: this.trades.slice(-80), day: this.day, running: this.running };
    }

    emit(type, text, data) {
      const e = { id: uid(), ts: Date.now(), type, text, data: data || {} };
      this.events.push(e); if (this.events.length > 120) this.events.shift();
      this.onEvent(e);
      return e;
    }
    say(kind, vars, data) {
      const lines = LINES[kind]; if (!lines) return;
      const v = Object.assign({ name: this.agent.name }, vars || {});
      this.lastSay = Date.now();
      return this.emit('say', fill(pick(lines), v), Object.assign({ kind }, data || {}));
    }
    gainXp(n, why) {
      const before = levelFromXp(this.agent.xp);
      this.agent.xp += Math.max(0, Math.round(n));
      const after = levelFromXp(this.agent.xp);
      if (after > before) {
        this.emit('level', `Reached level ${after}: ${TITLES[Math.min(after, TITLES.length - 1)]}`, { level: after });
        this.say('levelup', { level: after });
      }
    }
    checkAchievements() {
      for (const a of ACHIEVEMENTS) {
        if (!this.achievements[a.id] && a.test(this)) {
          this.achievements[a.id] = Date.now();
          this.emit('achievement', `${a.icon} ${a.name}: ${a.desc}`, { id: a.id });
          this.say('achievement', { ach: a.name });
          this.gainXp(40, 'achievement');
        }
      }
    }
    modeStats() { return (this.stats.modes[this.mode] = this.stats.modes[this.mode] || { trades: 0, wins: 0, pnl: 0 }); }
    liveUnlock() {
      const p = this.stats.modes.paper || { trades: 0, wins: 0, pnl: 0 };
      const level = levelFromXp(this.agent.xp);
      const reqs = [
        { label: 'Reach level 5', ok: level >= 5, have: `level ${level}` },
        { label: '20+ paper trades', ok: p.trades >= 20, have: `${p.trades} trades` },
        { label: 'Profitable on paper', ok: p.pnl > 0, have: fmtUsd(p.pnl) },
        { label: 'Live keys + ALLOW_LIVE=true in .env', ok: this.liveAvailable, have: this.liveAvailable ? 'configured' : 'not set' },
      ];
      return { ok: reqs.every((r) => r.ok), reqs };
    }

    mood() {
      if (this.day.halted) return 'shaken';
      if (!this.running) return 'chill';
      const syms = this.settings.watchlist;
      if (syms.length && syms.every((s) => this.market[s] && this.market[s].open === false)) return 'sleepy';
      if (this.agent.streak >= 3) return 'ecstatic';
      if (this.agent.lossStreak >= 3) return 'grumpy';
      if (this.agent.streak >= 1) return 'happy';
      if (this.agent.lossStreak >= 1) return 'nervous';
      return 'focused';
    }

    rollDay(equity) {
      const d = new Date(this.broker.now());
      const key = d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
      if (this.day.key !== key) this.day = { key, startEquity: equity, trades: 0, halted: false };
      if (this.day.startEquity == null) this.day.startEquity = equity;
    }

    async tick() {
      if (this.busy) return;
      this.busy = true;
      try {
        if (this.broker.advance) this.broker.advance(this.settings.watchlist);
        this.account = await this.broker.getAccount();
        this.positions = await this.broker.getPositions();
        this.rollDay(this.account.equity);
        const posBySym = {};
        for (const p of this.positions) posBySym[p.symbol] = p;
        // forget metas for positions that were closed elsewhere
        for (const sym of Object.keys(this.metas)) if (!posBySym[sym] && Date.now() - this.metas[sym].placedAt > 120000) delete this.metas[sym];
        for (const p of this.positions) if (this.metas[p.symbol]) { this.metas[p.symbol].entryPrice = p.avgPrice; this.metas[p.symbol].qty = p.qty; }

        for (const sym of this.settings.watchlist) {
          try {
            const [bars, open] = await Promise.all([this.broker.getBars(sym, 120), this.broker.isOpen(sym)]);
            this.market[sym] = Object.assign(this.market[sym] || {}, { bars, open, price: bars.length ? bars[bars.length - 1].c : null });
          } catch (e) { this.market[sym] = Object.assign(this.market[sym] || {}, { error: e.message }); }
        }
        const managed = this.positions.filter((p) => this.metas[p.symbol]);
        this.agent.maxConcurrent = Math.max(this.agent.maxConcurrent, managed.length);

        const tradesBefore = this.day.trades, closedBefore = this.stats.trades;
        if (this.running) {
          const s = this.settings;
          const dd = this.day.startEquity ? (this.account.equity - this.day.startEquity) / this.day.startEquity : 0;
          if (!this.day.halted && dd <= -s.dailyLossLimitPct) {
            this.day.halted = true;
            this.emit('warn', `Daily loss limit (${(s.dailyLossLimitPct * 100).toFixed(1)}%) reached. New entries paused until tomorrow.`);
            this.say('halted');
          }
          const now = this.broker.now();
          // exits
          for (const p of managed) {
            const m = this.market[p.symbol]; if (!m || !m.open || !m.bars || !m.bars.length) continue;
            const meta = this.metas[p.symbol];
            const strat = this.brain.get(meta.strategyId);
            const closes = m.bars.map((b) => b.c);
            const px = closes[closes.length - 1];
            const chg = (px - meta.entryPrice) / meta.entryPrice;
            const heldMin = (now - meta.openedAt) / 60000;
            let why = null;
            if (chg <= -s.stopLossPct) why = 'stop';
            else if (chg >= s.takeProfitPct) why = 'tp';
            else if (heldMin >= s.maxHoldMinutes) why = 'time';
            else if (strat && heldMin >= 10) {
              const sig = STRATEGY_TYPES[strat.type].signal(closes, strat.params, true);
              if (sig.action === 'sell') why = 'signal:' + sig.reason;
            }
            if (why) await this.exit(p, meta, strat, why, px);
          }
          // entries
          if (!this.day.halted) {
            let open = this.positions.filter((p) => this.metas[p.symbol]).length;
            for (const sym of this.settings.watchlist) {
              if (open >= s.maxOpenPositions || this.day.trades >= s.maxTradesPerDay) break;
              if (posBySym[sym] || this.metas[sym]) continue; // never touch positions we didn't open
              if (this.cooldowns[sym] && now < this.cooldowns[sym]) continue;
              const m = this.market[sym]; if (!m || !m.open || !m.bars || m.bars.length < 30) continue;
              const strat = this.brain.choose(sym); if (!strat) continue;
              const closes = m.bars.map((b) => b.c);
              const sig = STRATEGY_TYPES[strat.type].signal(closes, strat.params, false);
              m.signal = { strat: strat.name, action: sig.action, reason: sig.reason };
              const threshold = 0.35 + this.agent.patience * 0.3 - this.agent.boldness * 0.15;
              if (sig.action === 'buy' && sig.confidence >= threshold) {
                if (await this.enter(sym, strat, sig, closes[closes.length - 1])) open++;
              }
            }
          }
          const evo = this.brain.maybeEvolve(this.agent.curiosity);
          for (const e of evo) {
            if (e.kind === 'experiment') { this.emit('learn', e.text, { kind: 'experiment' }); this.say('experiment', { strat: e.strat.name }); this.gainXp(15); }
            else { this.emit('learn', e.text, { kind: 'retire' }); this.say('retire', { strat: e.strat.name }); this.gainXp(10); }
          }
          if (Date.now() - this.lastSay > 25000 && Math.random() < 0.25) {
            const mood = this.mood();
            this.say(mood === 'sleepy' ? 'sleepy' : 'idle', { sym: pick(this.settings.watchlist) || 'the market' });
          }
          this.checkAchievements();
          // refresh after any orders so the UI never shows stale positions
          if (this.day.trades !== tradesBefore || this.stats.trades !== closedBefore) {
            this.account = await this.broker.getAccount();
            this.positions = await this.broker.getPositions();
          }
        }
        this.connError = null;
      } catch (e) {
        // report a connection problem once, not every tick
        if (this.connError !== e.message) this.emit('warn', 'Connection problem: ' + e.message);
        this.connError = e.message;
      } finally {
        this.busy = false;
      }
    }

    async enter(sym, strat, sig, px) {
      const s = this.settings;
      const cap = this.mode === 'live' ? s.liveMaxOrderUsd : s.maxOrderUsd;
      let usd = this.account.equity * s.maxPositionPct * (0.5 + this.agent.boldness * 0.5) * (0.6 + sig.confidence * 0.4);
      usd = Math.min(usd, cap, (this.account.buyingPower != null ? this.account.buyingPower : this.account.cash) * 0.95);
      usd = Math.floor(usd * 100) / 100;
      if (usd < 1) return false;
      try {
        const r = await this.broker.buyNotional(sym, usd);
        const entry = r && r.price ? r.price : px;
        this.metas[sym] = { strategyId: strat.id, entryPrice: entry, openedAt: this.broker.now(), placedAt: Date.now(), usd, reason: sig.reason };
        this.day.trades++;
        this.trades.push({ sym, side: 'buy', price: entry, t: this.broker.now(), usd, strat: strat.name });
        this.emit('trade', `BUY ${sym} ${fmtUsd(usd)} @ ${entry.toPrecision(6)} via ${strat.name}`, { side: 'buy', sym, usd, price: entry, strat: strat.name });
        this.say('buy', { sym, strat: strat.name, reason: sig.reason });
        this.gainXp(5);
        return true;
      } catch (e) {
        this.emit('warn', `Order for ${sym} failed: ${e.message}`);
        return false;
      }
    }

    async exit(p, meta, strat, why, px) {
      try {
        const r = await this.broker.closePosition(p.symbol);
        const pnl = r && typeof r.pnl === 'number' ? r.pnl : p.unrealizedPnl;
        const exitPx = r && r.price ? r.price : px;
        const pct = (exitPx - meta.entryPrice) / meta.entryPrice;
        delete this.metas[p.symbol];
        this.cooldowns[p.symbol] = this.broker.now() + this.settings.cooldownMinutes * 60000;
        this.trades.push({ sym: p.symbol, side: 'sell', price: exitPx, t: this.broker.now(), pnl, strat: strat ? strat.name : '?' });
        const win = pnl > 0;
        this.stats.trades++; this.stats.pnl += pnl; if (win) this.stats.wins++;
        const ms = this.modeStats(); ms.trades++; ms.pnl += pnl; if (win) ms.wins++;
        const label = why.startsWith('signal:') ? why.slice(7) : why === 'stop' ? 'stop-loss' : why === 'tp' ? 'take-profit' : 'held too long';
        this.emit('trade', `SELL ${p.symbol} ${win ? '+' : ''}${fmtUsd(pnl)} (${(pct * 100).toFixed(2)}%), ${label}`, { side: 'sell', sym: p.symbol, pnl, pct, why, strat: strat ? strat.name : '' });
        // personality evolves
        const A = this.agent;
        if (win) {
          if (A.lossStreak >= 3) A.comeback = true;
          A.streak++; A.lossStreak = 0; A.bestStreak = Math.max(A.bestStreak, A.streak);
          A.boldness = clamp(A.boldness + 0.03, 0.15, 0.9);
          A.patience = clamp(A.patience - 0.01, 0.2, 0.9);
        } else {
          A.lossStreak++; A.streak = 0;
          A.boldness = clamp(A.boldness - 0.04, 0.15, 0.9);
          A.patience = clamp(A.patience + 0.02, 0.2, 0.9);
          A.curiosity = clamp(A.curiosity + 0.02, 0.2, 0.95);
        }
        const vars = { sym: p.symbol, pnl: fmtUsd(pnl), strat: strat ? strat.name : 'my gut' };
        if (why === 'stop') this.say('stop', vars);
        else if (why === 'tp') this.say('tp', vars);
        else if (win && pct > 0.03) this.say('bigwin', vars);
        else this.say(win ? 'win' : 'loss', vars);
        if (win && A.streak >= 3 && A.streak % 1 === 0 && Math.random() < 0.6) this.say('streak', { n: A.streak });
        this.gainXp(win ? 20 + Math.min(60, Math.abs(pct) * 1000) : 8, 'trade');
        if (strat) for (const ins of this.brain.record(strat.id, p.symbol, pnl, pct)) { this.emit('learn', ins.text, { kind: 'insight' }); this.gainXp(10); }
      } catch (e) {
        this.emit('warn', `Closing ${p.symbol} failed: ${e.message}`);
      }
    }

    async killSwitch() {
      this.running = false;
      this.say('kill');
      for (const p of this.positions) {
        const meta = this.metas[p.symbol]; if (!meta) continue;
        await this.exit(p, meta, this.brain.get(meta.strategyId), 'kill', p.price);
      }
      this.emit('warn', 'Kill switch used: agent stopped, its positions closed.');
    }

    async command(cmd, a) {
      a = a || {};
      switch (cmd) {
        case 'start': this.running = true; this.say('start'); break;
        case 'pause': this.running = false; this.say('pause'); break;
        case 'kill': await this.killSwitch(); break;
        case 'poke': {
          const fav = this.brain.active().slice().sort((x, y) => (y.wins + 1) / (y.trades + 2) - (x.wins + 1) / (x.trades + 2))[0];
          this.say('poke', { trades: this.stats.trades, fav: fav ? fav.name : 'none yet', bold: Math.round(this.agent.boldness * 100), mood: this.mood() });
          break;
        }
        case 'rename': if (a.name && String(a.name).trim()) { this.agent.name = String(a.name).trim().slice(0, 16); this.emit('info', `Agent renamed to ${this.agent.name}`); } break;
        case 'setting': {
          if (!(a.key in DEFAULT_SETTINGS) || a.key === 'watchlist') break;
          const v = Number(a.value); if (!isFinite(v) || v < 0) break;
          this.settings[a.key] = v; this.emit('info', `Setting ${a.key} = ${v}`); break;
        }
        case 'addSymbol': {
          const sym = String(a.symbol || '').toUpperCase().trim().replace(/[^A-Z/.]/g, '');
          if (sym && !this.settings.watchlist.includes(sym) && this.settings.watchlist.length < 12) { this.settings.watchlist.push(sym); this.emit('info', `Added ${sym} to watchlist`); }
          break;
        }
        case 'removeSymbol': this.settings.watchlist = this.settings.watchlist.filter((x) => x !== a.symbol); break;
        default: return false;
      }
      this.checkAchievements();
      return true;
    }

    snapshot() {
      const level = levelFromXp(this.agent.xp);
      const market = {};
      for (const sym of this.settings.watchlist) {
        const m = this.market[sym] || {};
        market[sym] = { bars: (m.bars || []).slice(-90), open: m.open, price: m.price, error: m.error, signal: m.signal };
      }
      return {
        mode: this.mode, broker: this.broker.name, running: this.running, now: this.broker.now(), connError: this.connError || null,
        agent: Object.assign({}, this.agent, { level, title: TITLES[Math.min(level, TITLES.length - 1)], xpLevel: xpForLevel(level), xpNext: xpForLevel(level + 1), mood: this.mood() }),
        account: this.account, day: this.day,
        positions: this.positions.map((p) => Object.assign({}, p, { managed: !!this.metas[p.symbol], meta: this.metas[p.symbol] ? Object.assign({}, this.metas[p.symbol], { strategy: (this.brain.get(this.metas[p.symbol].strategyId) || {}).name }) : null })),
        market, settings: this.settings, stats: this.stats,
        strategies: this.brain.strategies.map((s) => Object.assign({ blurb: STRATEGY_TYPES[s.type].blurb }, s)),
        journal: this.brain.journal.slice(-30),
        trades: this.trades.slice(-60),
        events: this.events.slice(-60),
        achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, icon: a.icon, desc: a.desc, unlocked: this.achievements[a.id] || null })),
        live: this.liveUnlock(),
      };
    }
  }

  return { Game, SimBroker, Brain, STRATEGY_TYPES, DEFAULT_SETTINGS, ACHIEVEMENTS, LINES, levelFromXp, xpForLevel, isCrypto, indicators: { sma, std, rsi } };
});
