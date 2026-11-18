# 🤖 Trading Agent Arena

A trading bot that plays like a video game. Your agent ("Byte" by default, and you can rename it) trades **stocks and crypto on Alpaca**. It has moods, levels and achievements, and it invents and tests its own strategy variants.

Real money stays locked until the agent proves itself on paper.

---

## Install (Windows desktop app)

1. Double-click **Trading-Agent-Arena-Setup.exe**. It installs in a few seconds, adds a **desktop shortcut** and opens the app.
   - Windows may show "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**. You only see this once.
2. The agent starts on a **practice simulator**. To trade the real market with fake money:
   - Make a free account at https://alpaca.markets, switch to your **Paper** account and generate **API keys**
   - In the app, click **⚙ → Alpaca connection**, paste both keys and click **Save & reconnect**
   - The badge in the top right now says **PAPER**
3. Press **▶ START**.

Your keys are encrypted with Windows' built-in protection and only ever sent to Alpaca. Your progress (XP, strategies, journal) is kept through updates and reinstalls. **⚙ → Open data folder** shows where it lives.

---

## Automatic updates

The app checks for updates when it opens and every 3 hours. New versions download in the background while the agent keeps working, and only the changed parts are downloaded. When one is ready, a purple **✨ READY · RESTART** button appears. Click it and the app restarts on the new version within seconds. It always comes back **paused and on paper**, with progress and keys kept. If you ignore the button, the update installs the next time you close the app.

Updates are published through **GitHub Releases** (free). One-time setup:

1. Make a free account at https://github.com and create a **public** repository named `trading-agent-arena`. Your API keys are never in the code, so public is safe.
2. Upload this project folder to it (GitHub Desktop is the easiest way).
3. In the app, go to **⚙ → Updates**, enter `your-github-name/trading-agent-arena` and click **Save**.

**Shipping an update or a fix:**

1. Change `"version"` in `package.json` (e.g. `1.0.1` → `1.0.2`) along with your fix, then **Commit to main** in GitHub Desktop
2. In GitHub Desktop open **History**, right-click that commit → **Create Tag…** → type `v1.0.2` (the same version with a `v`)
3. Click **Push origin**. That sends the commit and the tag, and GitHub builds the update.

GitHub then builds the new installer automatically (`.github/workflows/release.yml`, about 5 minutes) and publishes it as a release. Every installed copy picks it up on its own. Installers built by GitHub already know where to look for updates, so step 3 above is only needed for this first installer.

> The first release you publish must have a higher version than the one installed (e.g. `v1.0.1`), or there's nothing to update to.

---

## Running from source (optional, for development)

Requires Node.js 18+.

```
npm install
npm run app        # desktop window
npm start          # or: browser version at http://localhost:3777 (keys from .env, see .env.example)
npm run dist       # build the Windows installer into release/
```

---

## How the agent thinks

**Four founding strategies** (the "deck"):

| Card | What it does |
|---|---|
| 🌊 Trend Rider | Buys when a fast moving average crosses above a slow one |
| 🪀 Rubber Band | Buys when RSI says the price is oversold, sells when it snaps back |
| 🚀 Breakout Hunter | Buys when price breaks its recent high |
| 🎯 Band Bouncer | Buys under the lower Bollinger band, sells at the middle |

**How it learns**
- **Picking strategies:** before each trade the agent draws a "plausible win rate" for every strategy from its track record (Thompson sampling). It also weighs how each strategy has done on that specific symbol. Winners get picked more often, but unproven ones still get a chance.
- **Running experiments:** every few closed trades it may mutate a good strategy's settings into a new variant, like *Breakout Hunter Mk3*, and let it compete.
- **Retiring losers:** variants that keep losing go to the 🪦 Graveyard. The four founders are never retired.
- **Brain journal:** it writes down what it notices, like "Rubber Band seems to fit ETH/USD well."

**Personality**
- **Boldness** goes up with wins and down with losses. It scales trade size, within your risk limits.
- **Patience** rises after losses, so the agent waits for stronger signals.
- **Curiosity** controls how often it experiments.
- **Mood** (happy, ecstatic, nervous, grumpy, sleepy, shaken) shows on its face and in what it says. Click the robot to poke it.

**Leveling:** you earn XP for trades, wins, insights, experiments and achievements. There are 13 achievements to unlock.

---

## Safety rules (the agent can't break these)

All of these are adjustable in ⚙ Settings:

- Max % of equity per trade, plus a hard dollar cap per trade (**$25 when live** by default)
- Stop-loss and take-profit on every position
- Daily loss limit: if equity drops this much in a day, new trades stop until tomorrow
- Max open positions, max trades per day, max hold time
- **It only touches positions it opened.** Anything already in your account is labeled "Yours (untouched)."
- **⏻ KILL** stops the agent and closes everything it opened. Press twice to confirm.
- The server listens on your computer only (`127.0.0.1`), so your API keys never leave it.

### Unlocking real money

The ⚡ **GO LIVE** button stays locked until **all** of these are true:

1. The agent is level 5 or higher
2. It has closed 20+ trades on **paper**
3. Its total paper P&L is positive
4. You saved **live** keys in ⚙ → Alpaca connection *and* ticked "Allow the Go Live button"

Then you have to type `GO LIVE` to confirm. After a restart it always comes back on paper.

> ⚠️ This is a hobby project, not financial advice. Simple technical strategies don't reliably beat the market, and paper results often look better than real trading because of fees, slippage and partial fills. Only trade money you can afford to lose.

---

## Notes

- **Market hours:** stocks only trade when the US market is open. Crypto trades 24/7, so the agent stays busy at night with BTC/ETH.
- **Watchlist:** add symbols in Settings. Stocks look like `TSLA`, crypto looks like `SOL/USD`.
- **Data:** uses Alpaca's free IEX feed and 5-minute candles. The agent checks the market every 30 seconds.
- **Saved progress:** XP, strategies and the journal are saved in the app's data folder (⚙ → Open data folder). Delete the `data` folder inside it to start over.
- **Demo:** `node build-demo.js` makes `dist/demo.html`, a single-file version that runs entirely in the browser on simulated data.

## Files

```
desktop/       Windows app shell: launcher, auto-updater, encrypted key storage
server.js      runs the agent + Alpaca connection + live-mode gate
alpaca.js      Alpaca API (orders, positions, bars, market clock)
core.js        the agent: strategies, learning brain, personality, risk rules, simulator
public/        the game UI (index.html, style.css, app.js)
build/         app icon
.github/       automatic build + release pipeline
.env.example   keys for the browser/dev version only
```
