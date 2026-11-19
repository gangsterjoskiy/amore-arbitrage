const START_BALANCE = 1000;
const BOTS = ["arbi", "trading"];

function emptyWallet() {
  return {
    initial: START_BALANCE,
    balance: START_BALANCE,
    trades: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    pnl: 0,
    updatedAt: new Date().toISOString()
  };
}

export async function getDemoAccount(env, chatId) {
  if (!env.SUBSCRIBERS) throw new Error("KV namespace SUBSCRIBERS is not configured");
  const key = "demo:" + chatId;
  const raw = await env.SUBSCRIBERS.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      for (const bot of BOTS) {
        if (!parsed[bot] || typeof parsed[bot] !== "object") parsed[bot] = emptyWallet();
      }
      return parsed;
    } catch {
      // Replace malformed demo data with a clean virtual account.
    }
  }
  const account = { arbi: emptyWallet(), trading: emptyWallet() };
  await env.SUBSCRIBERS.put(key, JSON.stringify(account));
  return account;
}

export async function getDemoHistory(env, chatId) {
  if (!env.SUBSCRIBERS) throw new Error("KV namespace SUBSCRIBERS is not configured");
  const raw = await env.SUBSCRIBERS.get("demo:history:" + chatId);
  if (!raw) return [];
  try { const rows = JSON.parse(raw); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
}

export async function resetDemoAccount(env, chatId) {
  const account = { arbi: emptyWallet(), trading: emptyWallet() };
  await env.SUBSCRIBERS.put("demo:" + chatId, JSON.stringify(account));
  await env.SUBSCRIBERS.put("demo:history:" + chatId, "[]");
  await env.SUBSCRIBERS.delete("paper:trading:" + chatId);
  return account;
}

export async function applyDemoResult(env, chatId, bot, pnl, outcome, details = {}) {
  if (!BOTS.includes(bot)) throw new Error("Unknown demo bot");
  if (!Number.isFinite(pnl)) throw new Error("Demo PnL must be a finite number");
  const account = await getDemoAccount(env, chatId);
  const wallet = account[bot];
  wallet.balance = Math.max(0, Number((wallet.balance + pnl).toFixed(8)));
  wallet.pnl = Number((wallet.pnl + pnl).toFixed(8));
  wallet.trades += 1;
  if (outcome === "win") wallet.wins += 1;
  else if (outcome === "loss") wallet.losses += 1;
  else wallet.draws += 1;
  wallet.updatedAt = new Date().toISOString();
  await env.SUBSCRIBERS.put("demo:" + chatId, JSON.stringify(account));
  const history = await getDemoHistory(env, chatId);
  history.unshift({
    id: String(Date.now()) + ":" + Math.random().toString(36).slice(2, 8),
    bot, outcome, pnl, at: new Date().toISOString(), ...details
  });
  await env.SUBSCRIBERS.put("demo:history:" + chatId, JSON.stringify(history.slice(0, 100)));
  return account;
}

export function formatDemoAccount(account) {
  const line = (name, wallet, kind) => {
    const accuracy = wallet.trades ? ((wallet.wins / wallet.trades) * 100).toFixed(1) : "—";
    const stats = kind === "arbi"
      ? "Модельных записей: " + wallet.trades
      : "Прогнозов: " + wallet.trades + " • ✅ " + wallet.wins + " • ❌ " + wallet.losses + " • ➖ " + wallet.draws;
    const accuracyLabel = kind === "arbi" ? "не оценивается по top-of-book" : accuracy === "—" ? "—" : accuracy + "%";
    const sign = wallet.pnl > 0 ? "+" : "";
    return "<b>" + name + "</b>\n" +
      "Баланс: <b>" + wallet.balance.toFixed(2) + " USDT</b>\n" +
      "P/L: <b>" + sign + wallet.pnl.toFixed(2) + " USDT</b>\n" +
      stats + "\n" +
      "Доля успешных: <b>" + accuracyLabel + "</b>";
  };
  return "🧪 <b>A|MORE — ДЕМО-БАЛАНСЫ</b>\n\n" +
    line("📊 A|MORE Arbitrage", account.arbi, "arbi") + "\n\n" +
    line("📈 A|MORE Signals", account.trading, "trading") +
    "\n\n<i>Виртуальные средства. Реальные деньги и ордера не используются.</i>";
}
