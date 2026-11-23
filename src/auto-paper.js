const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_TTL_SECONDS = 35 * 24 * 60 * 60;

const stateKey = chatId => "auto:paper:state:" + chatId;
const dailyKey = (chatId, day) => "auto:paper:daily:" + chatId + ":" + day;

async function stateObject(env, chatId) {
  if (!env.AUTO_PAPER_STATE) throw new Error("Durable Object AUTO_PAPER_STATE не привязан к Worker.");
  const id = env.AUTO_PAPER_STATE.idFromName(String(chatId));
  return env.AUTO_PAPER_STATE.get(id);
}
async function stateRequest(env, chatId, action, payload = {}) {
  const stub = await stateObject(env, chatId);
  const response = await stub.fetch("https://auto-paper-state/" + action, {
    method: "POST", headers: {"content-type":"application/json"},
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Durable Object state error: HTTP " + response.status);
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result;
}

export async function readAutoPaper(env, chatId) {
  const result = await stateRequest(env, chatId, "read");
  if (result.state) return result.state;
  // One-time, lossless migration of an existing KV state into the authoritative DO.
  const legacy = await env.SUBSCRIBERS.get(stateKey(chatId));
  if (!legacy) return null;
  let state;
  try { state = JSON.parse(legacy); } catch { return null; }
  await stateRequest(env, chatId, "write", {state});
  return state;
}

export async function writeAutoPaper(env, chatId, state) {
  await stateRequest(env, chatId, "write", {state});
  // Keep a KV discovery index for the minute Cron; the DO remains authoritative.
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
    startingCapital: 10,
    paperCapital: 10,
    quoteBudget: 10,
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
  state.startingCapital = Number(state.startingCapital) || 10;
  state.paperCapital = Number(((Number(state.paperCapital) || state.startingCapital) + Number(trade.pnl || 0)).toFixed(8));
  state.quoteBudget = Math.max(0, state.paperCapital);
  if (state.paperCapital <= 0.01) {
    state.enabled = false;
    state.stopReason = "paper-capital-depleted";
    state.stoppedAt = Date.now();
  }
  state.lastTradeAt = Date.now();
  state.lastError = null;
  await writeAutoPaper(env, chatId, state);
  const day = new Date().toISOString().slice(0, 10);
  const legacyCount = Number(await env.SUBSCRIBERS.get(dailyKey(chatId, day)) || 0) || 0;
  await stateRequest(env, chatId, "increment-daily", {day, legacyCount});
  return state;
}

export async function getAutoPaperDailyCount(env, chatId, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const legacyCount = Number(await env.SUBSCRIBERS.get(dailyKey(chatId, day)) || 0) || 0;
  const result = await stateRequest(env, chatId, "daily-count", {day, legacyCount});
  return Number(result.count) || 0;
}

// One durable, strongly consistent state object per Telegram user. Telegram is only
// a control surface; closing the Mini App never changes this persistent state.
export class AutoPaperState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    try {
      const action = new URL(request.url).pathname.slice(1);
      const body = request.method === "POST" ? await request.json() : {};
      if (action === "read") {
        return Response.json({state: await this.ctx.storage.get("state") || null});
      }
      if (action === "write") {
        if (!body.state || typeof body.state !== "object") return Response.json({error:"Invalid state"}, {status:400});
        await this.ctx.storage.put("state", body.state);
        return Response.json({ok:true,state:body.state});
      }
      if (action === "daily-count") {
        const key = "daily:" + String(body.day || "");
        let count = await this.ctx.storage.get(key);
        if (count === undefined) {
          count = Math.max(0, Number(body.legacyCount) || 0);
          await this.ctx.storage.put(key, count);
        }
        return Response.json({count});
      }
      if (action === "increment-daily") {
        const key = "daily:" + String(body.day || "");
        let count = await this.ctx.storage.get(key);
        if (count === undefined) count = Math.max(0, Number(body.legacyCount) || 0);
        count = Number(count) + 1;
        await this.ctx.storage.put(key, count);
        return Response.json({count});
      }
      return Response.json({error:"Unknown action"}, {status:404});
    } catch (error) {
      console.error("AutoPaperState:", error);
      return Response.json({error:String(error?.message || error)}, {status:500});
    }
  }
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
        exchange: options.exchange || "Bybit",
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
      assetBtc.bid * assetBtc.bidQty * btcUsdt.bid,
      btcUsdt.bid * btcUsdt.bidQty
    );
    if (Number.isFinite(reverseNet) && reverseNet >= minNetPercent && reverseDepth >= minDepthUsdt) {
      opportunities.push({
        strategy: "triangular",
        symbol: asset + "USDT",
        asset,
        exchange: options.exchange || "Bybit",
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

// Conservative execution stress: worsen every consumed book level rather than
// assuming the displayed quote remains available at the instant of execution.
export function applyAdverseSlippage(levels, side, bps = 10) {
  const rate = Math.max(0, Math.min(500, Number(bps) || 0)) / 10000;
  const factor = side === "buy" ? 1 + rate : 1 - rate;
  return (Array.isArray(levels) ? levels : []).map(([price, quantity]) => [Number(price) * factor, Number(quantity)]);
}

export function executionLatencyAllowed(latencyMs, maxLatencyMs = 5000) {
  return Number.isFinite(Number(latencyMs)) && Number(latencyMs) >= 0 && Number(latencyMs) <= Number(maxLatencyMs);
}
