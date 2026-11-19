import { getDemoAccount, applyDemoResult } from "./demo.js";

const TRADE_STAKE = 10;
const PAYOUT = 0.8;
const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

async function candles(symbol) {
  const url = "https://api.binance.com/api/v3/klines?symbol=" + symbol + "&interval=1m&limit=60";
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error("Binance candles HTTP " + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length < 30) throw new Error("Недостаточно свечей для " + symbol);
  return rows.map(x => ({ open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]), volume: Number(x[5]), closeTime: Number(x[6]) }));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}

function rsi(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = values.length - period - 1; i < values.length - 1; i++) {
    const delta = values[i + 1] - values[i];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function analyze(rows) {
  // Exclude the currently forming candle to avoid look-ahead and unstable signals.
  const closed = rows.slice(0, -1);
  const closes = closed.map(x => x.close);
  const last = closed[closed.length - 1], prev = closed[closed.length - 2];
  const fast = ema(closes.slice(-30), 9);
  const slow = ema(closes.slice(-40), 21);
  const momentum = rsi(closes, 14);
  let up = 0, down = 0;
  const upReasons = [], downReasons = [];
  if (fast > slow) { up++; upReasons.push("EMA 9 выше EMA 21"); }
  if (fast < slow) { down++; downReasons.push("EMA 9 ниже EMA 21"); }
  if (momentum >= 52 && momentum <= 68) { up++; upReasons.push("RSI в бычьей зоне (" + momentum.toFixed(1) + ")"); }
  if (momentum <= 48 && momentum >= 32) { down++; downReasons.push("RSI в медвежьей зоне (" + momentum.toFixed(1) + ")"); }
  if (last.close > last.open && last.close > prev.close) { up++; upReasons.push("положительная свечная динамика"); }
  if (last.close < last.open && last.close < prev.close) { down++; downReasons.push("отрицательная свечная динамика"); }
  const direction = up > down ? "UP" : down > up ? "DOWN" : null;
  const score = Math.max(up, down);
  if (!direction || score < 3) return null;
  return { direction, score, reasons: direction === "UP" ? upReasons : downReasons, entry: last.close, candleCloseTime: last.closeTime };
}

export async function openTradingDemo(env, chatId) {
  if (!env.SUBSCRIBERS) throw new Error("KV namespace SUBSCRIBERS is not configured");
  const key = "paper:trading:" + chatId;
  const active = await env.SUBSCRIBERS.get(key);
  if (active) return { active: JSON.parse(active) };
  const account = await getDemoAccount(env, chatId);
  if (account.trading.balance < TRADE_STAKE) throw new Error("На демо-балансе Трейдинга недостаточно средств.");
  const candidates = [];
  const errors = [];
  for (const symbol of PAIRS) {
    try {
      const rows = await candles(symbol);
      const signal = analyze(rows);
      if (signal) candidates.push({ symbol, ...signal });
    } catch (e) { errors.push(symbol + ": " + e.message); }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return { none: true, errors };
  const tickerResponse = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=" + best.symbol, { signal: AbortSignal.timeout(7000) });
  if (!tickerResponse.ok) throw new Error("Не удалось получить цену входа для " + best.symbol);
  const ticker = await tickerResponse.json();
  const entry = Number(ticker.price);
  if (!Number.isFinite(entry) || entry <= 0) throw new Error("Некорректная цена входа");
  const now = Date.now();
  const trade = {
    id: String(chatId) + ":" + now,
    symbol: best.symbol,
    direction: best.direction,
    entry,
    stake: TRADE_STAKE,
    payout: PAYOUT,
    openedAt: now,
    settleAt: now + 60000,
    reasons: best.reasons,
    score: best.score
  };
  await env.SUBSCRIBERS.put(key, JSON.stringify(trade), { expirationTtl: 600 });
  return { trade };
}

export async function settleTradingDemos(env) {
  if (!env.SUBSCRIBERS) return;
  const list = await env.SUBSCRIBERS.list({ prefix: "paper:trading:", limit: 1000 });
  for (const item of list.keys) {
    const raw = await env.SUBSCRIBERS.get(item.name);
    if (!raw) continue;
    let trade;
    try { trade = JSON.parse(raw); } catch { await env.SUBSCRIBERS.delete(item.name); continue; }
    if (Date.now() < trade.settleAt) continue;
    try {
      const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=" + trade.symbol, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) continue;
      const quote = await response.json();
      const exit = Number(quote.price);
      if (!Number.isFinite(exit) || exit <= 0) continue;
      const outcome = exit === trade.entry ? "draw" :
        (trade.direction === "UP" ? exit > trade.entry : exit < trade.entry) ? "win" : "loss";
      const pnl = outcome === "win" ? trade.stake * trade.payout : outcome === "loss" ? -trade.stake : 0;
      await applyDemoResult(env, item.name.slice("paper:trading:".length), "trading", pnl, outcome);
      await env.SUBSCRIBERS.delete(item.name);
      const label = outcome === "win" ? "✅ ПРОГНОЗ СБЫЛСЯ" : outcome === "loss" ? "❌ ПРОГНОЗ НЕ СБЫЛСЯ" : "➖ НИЧЬЯ";
      const text = "⏱ <b>Трейдинг — результат демо-сделки</b>\n" + label +
        "\nПара: <b>" + trade.symbol + "</b>\nПрогноз: <b>" + trade.direction + "</b>" +
        "\nВход: " + trade.entry + "\nЦена после экспирации: " + exit +
        "\nP/L: <b>" + (pnl > 0 ? "+" : "") + pnl.toFixed(2) + " USDT</b>" +
        "\n<i>Демо-модель: выплата " + Math.round(trade.payout * 100) + "% от ставки при верном направлении. Это не исполнение у брокера.</i>";
      const token = env.TELEGRAM_BOT_TOKEN;
      if (token) await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: item.name.slice("paper:trading:".length), text, parse_mode: "HTML" })
      });
    } catch (e) { console.error("Paper trade settlement:", item.name, e); }
  }
}

export function formatOpenTrade(trade) {
  return "🔵 <b>ТРЕЙДИНГ — ДЕМО-СИГНАЛ</b>\n" +
    "Пара: <b>" + trade.symbol + "</b>\n" +
    "Прогноз: <b>" + (trade.direction === "UP" ? "🟢 ВВЕРХ ↑" : "🔴 ВНИЗ ↓") + "</b>\n" +
    "Виртуальная ставка: <b>" + trade.stake + " USDT</b>\n" +
    "Цена входа: <b>" + trade.entry + "</b>\n" +
    "Экспирация: <b>1 минута</b>\n" +
    "Факторы: " + trade.reasons.join("; ") + "\n" +
    "Оценка модели: " + trade.score + "/3 подтверждений\n\n" +
    "<i>Результат будет рассчитан после экспирации. Это экспериментальная стратегия, не проверенная на статистически значимой выборке.</i>";
}
