/*
 * AlpacaBroker — connects the agent to Alpaca (stocks + crypto).
 * Paper:  https://paper-api.alpaca.markets   Live: https://api.alpaca.markets
 * Market data: https://data.alpaca.markets (free IEX feed for stocks)
 */
'use strict';
const { isCrypto } = require('./core.js');

class AlpacaBroker {
  constructor({ keyId, secret, live }) {
    if (!keyId || !secret) throw new Error('Alpaca keys missing');
    this.mode = live ? 'live' : 'paper';
    this.name = live ? 'Alpaca LIVE' : 'Alpaca Paper';
    this.base = live ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    this.data = 'https://data.alpaca.markets';
    this.headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
    this.clock = { at: 0, open: false };
    this.barCache = {};
  }

  async req(url, opts = {}) {
    const res = await fetch(url, Object.assign({ headers: this.headers }, opts));
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!res.ok) {
      const msg = body && body.message ? body.message : `${res.status} ${res.statusText}`;
      throw new Error(`Alpaca: ${msg}`);
    }
    return body;
  }

  now() { return Date.now(); }

  async isOpen(sym) {
    if (isCrypto(sym)) return true;
    if (Date.now() - this.clock.at > 60000) {
      const c = await this.req(`${this.base}/v2/clock`);
      this.clock = { at: Date.now(), open: !!c.is_open };
    }
    return this.clock.open;
  }

  async getAccount() {
    const a = await this.req(`${this.base}/v2/account`);
    if (a.trading_blocked || a.account_blocked) throw new Error('Alpaca account is blocked from trading');
    return { equity: +a.equity, cash: +a.cash, buyingPower: +(a.non_marginable_buying_power || a.cash) };
  }

  // Alpaca returns crypto positions as "BTCUSD"; normalize back to "BTC/USD".
  normSym(s, assetClass) {
    if (assetClass === 'crypto' && !s.includes('/')) {
      for (const q of ['USDT', 'USDC', 'USD', 'BTC']) if (s.endsWith(q)) return s.slice(0, -q.length) + '/' + q;
    }
    return s;
  }

  async getPositions() {
    const ps = await this.req(`${this.base}/v2/positions`);
    return ps.map((p) => ({
      symbol: this.normSym(p.symbol, p.asset_class),
      qty: +p.qty, avgPrice: +p.avg_entry_price, price: +p.current_price,
      marketValue: +p.market_value, unrealizedPnl: +p.unrealized_pl,
    }));
  }

  async getBars(sym, n) {
    // cache bars for 30s so the UI and agent don't hammer the API
    const c = this.barCache[sym];
    if (c && Date.now() - c.at < 30000) return c.bars;
    const start = new Date(Date.now() - (isCrypto(sym) ? 3 : 7) * 86400000).toISOString();
    let raw;
    if (isCrypto(sym)) {
      const q = new URLSearchParams({ symbols: sym, timeframe: '5Min', start, limit: String(n), sort: 'desc' });
      const r = await this.req(`${this.data}/v1beta3/crypto/us/bars?${q}`);
      raw = (r.bars && r.bars[sym]) || [];
    } else {
      const q = new URLSearchParams({ timeframe: '5Min', start, limit: String(n), sort: 'desc', feed: 'iex', adjustment: 'raw' });
      const r = await this.req(`${this.data}/v2/stocks/${encodeURIComponent(sym)}/bars?${q}`);
      raw = r.bars || [];
    }
    const bars = raw.map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })).sort((a, b) => a.t - b.t);
    this.barCache[sym] = { at: Date.now(), bars };
    return bars;
  }

  async buyNotional(sym, usd) {
    const order = {
      symbol: sym, side: 'buy', type: 'market',
      notional: usd.toFixed(2),
      time_in_force: isCrypto(sym) ? 'gtc' : 'day',
      client_order_id: 'agent-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    };
    const o = await this.req(`${this.base}/v2/orders`, { method: 'POST', body: JSON.stringify(order) });
    return { id: o.id, price: o.filled_avg_price ? +o.filled_avg_price : null };
  }

  async closePosition(sym) {
    // capture P&L right before closing
    let pnl = null, price = null;
    try {
      const ps = await this.getPositions();
      const p = ps.find((x) => x.symbol === sym);
      if (p) { pnl = p.unrealizedPnl; price = p.price; }
    } catch (_) {}
    await this.req(`${this.base}/v2/positions/${encodeURIComponent(sym.replace('/', ''))}`, { method: 'DELETE' });
    return { pnl, price };
  }
}

module.exports = { AlpacaBroker };
