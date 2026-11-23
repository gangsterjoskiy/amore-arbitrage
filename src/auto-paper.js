const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_TTL_SECONDS = 35 * 24 * 60 * 60;

const stateKey = chatId => "auto:paper:" + chatId;
const dailyKey = (chatId, day) => "auto:paper:daily:" + chatId + ":" + day;

export async function readAutoPaper(env, chatId) {
  const raw = await env.SUBSCRIBERS.get(stateKey(chatId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function writeAutoPaper(env, chatId, state) {
  const ttl = Math.max(60, Math.ceil(((state.endsAt || Date.now() + DAY_MS) - Date.now()) / 1000) + 5 * 24 * 60 * 60);
  await env.SUBSCRIBERS.put(stateKey(chatId), JSON.stringify(state), {
    expirationTtl: Math.min(STATE_TTL_SECONDS, ttl)
  });
  return state;
}

export async function startAutoPaper(env, chatId, now = Date.now()) {
  const existing = await readAutoPaper(env, chatId);
  if (existing?.enabled && Number(existing.endsAt) > now) return existing;
  const state = {
    enabled: true,
    mode: "paper",
    strategies: ["cross_exchange", "triangular"],
    startedAt: now,
    endsAt: now + 30 * DAY_MS,
    quoteBudget: 100,
    maxTradesPerDay: 12,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    pnl: 0,
    lastTradeAt: null,
    lastError: null
  };
  return writeAutoPaper(env, chatId, state);
}

export async function stopAutoPaper(env, chatId, reason = "manual") {
  const state = await readAutoPaper(env, chatId) || {
    mode: "paper", strategies: ["cross_exchange", "triangular"], tradeCount: 0,
    wins: 0, losses: 0, draws: 0, pnl: 0
  };
  state.enabled = false;
  state.stoppedAt = Date.now();
  state.stopReason = reason;
  return writeAutoPaper(env, chatId, state);
}

export async function recordAutoPaperTrade(env, chatId, trade) {
  const state = await readAutoPaper(env, chatId);
  if (!state) return null;
  state.tradeCount = (Number(state.tradeCount) || 0) + 1;
  if (trade.outcome === "win") state.wins = (Number(state.wins) || 0) + 1;
  else if (trade.outcome === "loss") state.losses = (Number(state.losses) || 0) + 1;
  else state.draws = (Number(state.draws) || 0) + 1;
  state.pnl = Number(((Number(state.pnl) || 0) + Number(trade.pnl || 0)).toFixed(8));
  state.lastTradeAt = Date.now();
  state.lastError = null;
  await writeAutoPaper(env, chatId, state);
  const day = new Date().toISOString().slice(0, 10);
  const key = dailyKey(chatId, day);
  const count = Number(await env.SUBSCRIBERS.get(key) || 0) || 0;
  await env.SUBSCRIBERS.put(key, String(count + 1), { expirationTtl: 3 * 24 * 60 * 60 });
  return state;
}

export async function getAutoPaperDailyCount(env, chatId, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return Number(await env.SUBSCRIBERS.get(dailyKey(chatId, day)) || 0) || 0;
}

export function calculateTriangularOpportunities(tickers, options = {}) {
  const feePercent = Number.isFinite(Number(options.feePercent)) ? Number(options.feePercent) : 0.1;
  const minNetPercent = Number.isFinite(Number(options.minNetPercent)) ? Number(options.minNetPercent) : 0.25;
  const minDepthUsdt = Number.isFinite(Number(options.minDepthUsdt)) ? Number(options.minDepthUsdt) : 25;
  const feeFactor = Math.pow(1 - feePercent / 100, 3);
  const map = new Map();
  for (const row of Array.isArray(tickers) ? tickers : []) {
    const symbol = String(row.symbol || "");
    const bid = Number(row.bid1Price), ask = Number(row.ask1Price);
    const bidQty = Number(row.bid1Size), askQty = Number(row.ask1Size);
    if (symbol && [bid, ask, bidQty, askQty].every(Number.isFinite) &&
        bid > 0 && ask > 0 && ask >= bid && bidQty > 0 && askQty > 0) {
      map.set(symbol, { bid, ask, bidQty, askQty });
    }
  }

  const opportunities = [];
  for (const asset of ["ETH", "SOL", "BNB", "XRP"]) {
    const btcUsdt = map.get("BTCUSDT");
    const assetBtc = map.get(asset + "BTC");
    const assetUsdt = map.get(asset + "USDT");
    if (!btcUsdt || !assetBtc || !assetUsdt) continue;

    const forwardMultiplier = (1 / btcUsdt.ask) * (1 / assetBtc.ask) * assetUsdt.bid * feeFactor;
    const forwardNet = (forwardMultiplier - 1) * 100;
    const forwardDepth = Math.min(
      btcUsdt.ask * btcUsdt.askQty,
      assetBtc.ask * assetBtc.askQty * btcUsdt.ask,
      assetUsdt.bid * assetUsdt.bidQty
    );
    if (Number.isFinite(forwardNet) && forwardNet >= minNetPercent && forwardDepth >= minDepthUsdt) {
      opportunities.push({
        strategy: "triangular",
        symbol: asset + "USDT",
        asset,
        exchange: "Bybit",
        direction: "USDT_BTC_ASSET_USDT",
        route: "USDT → BTC → " + asset + " → USDT",
        net: forwardNet,
        depth: forwardDepth,
        feePercent
      });
    }

    const reverseMultiplier = (1 / assetUsdt.ask) * assetBtc.bid * btcUsdt.bid * feeFactor;
    const reverseNet = (reverseMultiplier - 1) * 100;
    const reverseDepth = Math.min(
      assetUsdt.ask * assetUsdt.askQty,
      assetBtc.bid * assetBtc.bidQty * assetUsdt.ask,
      btcUsdt.bid * btcUsdt.bidQty * assetUsdt.ask * assetBtc.bid
    );
    if (Number.isFinite(reverseNet) && reverseNet >= minNetPercent && reverseDepth >= minDepthUsdt) {
      opportunities.push({
        strategy: "triangular",
        symbol: asset + "USDT",
        asset,
        exchange: "Bybit",
        direction: "USDT_ASSET_BTC_USDT",
        route: "USDT → " + asset + " → BTC → USDT",
        net: reverseNet,
        depth: reverseDepth,
        feePercent
      });
    }
  }
  return opportunities.sort((a, b) => b.net - a.net);
}
