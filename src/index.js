import { getDemoAccount, resetDemoAccount, formatDemoAccount, applyDemoResult } from "./demo.js";
import { openTradingDemo, settleTradingDemos, formatOpenTrade } from "./paper.js";


const EXCHANGES = [
  { id: "Binance", url: "https://api.binance.com/api/v3/ticker/bookTicker", fee: "BINANCE_TAKER_FEE",
    parse: (p) => p.filter(x => x.symbol && x.symbol.endsWith("USDT")).map(x => ({
      symbol: x.symbol, bid: Number(x.bidPrice), ask: Number(x.askPrice),
      bidQty: Number(x.bidQty), askQty: Number(x.askQty)
    })) },
  { id: "Bybit", url: "https://api.bybit.com/v5/market/tickers?category=spot", fee: "BYBIT_TAKER_FEE",
    parse: (p) => {
      if (p.retCode !== 0 || !Array.isArray(p.result?.list)) throw new Error(p.retMsg || "Bybit response error");
      return p.result.list.filter(x => x.symbol?.endsWith("USDT")).map(x => ({
        symbol: x.symbol, bid: Number(x.bid1Price), ask: Number(x.ask1Price),
        bidQty: Number(x.bid1Size), askQty: Number(x.ask1Size)
      }));
    } },
  { id: "OKX", url: "https://www.okx.com/api/v5/market/tickers?instType=SPOT", fee: "OKX_TAKER_FEE",
    parse: (p) => {
      if (p.code !== "0" || !Array.isArray(p.data)) throw new Error(p.msg || "OKX response error");
      return p.data.filter(x => x.instId?.endsWith("-USDT")).map(x => ({
        symbol: x.instId.replace("-", ""), bid: Number(x.bidPx), ask: Number(x.askPx),
        bidQty: Number(x.bidSz), askQty: Number(x.askSz)
      }));
    } }
];

const setting = (value, fallback, max = 100) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
};
const html = (s) => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const price = (n) => n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(5);

async function getMarkets(exchange) {
  const response = await fetch(exchange.url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error(exchange.id + " HTTP " + response.status);
  const payload = await response.json();
  const rows = exchange.parse(payload);
  const markets = new Map();
  for (const x of rows) {
    if (!x.symbol || !Number.isFinite(x.bid) || !Number.isFinite(x.ask) ||
        x.bid <= 0 || x.ask <= 0 || x.ask < x.bid) continue;
    const base = x.symbol.slice(0, -4);
    if (/(UP|DOWN|BULL|BEAR|2L|2S|3L|3S)$/.test(base)) continue;
    markets.set(x.symbol, x);
  }
  return { exchange, markets };
}

async function scan(env) {
  const settled = await Promise.allSettled(EXCHANGES.map(getMarkets));
  const venues = settled.filter(x => x.status === "fulfilled").map(x => x.value);
  const errors = settled.filter(x => x.status === "rejected").map(x => String(x.reason?.message || x.reason));
  if (venues.length < 2) throw new Error("Доступно меньше двух бирж. " + errors.join("; "));
  const minNet = setting(env.MIN_NET_SPREAD_PERCENT, 0.25, 20);
  const minDepth = setting(env.MIN_TOP_OF_BOOK_DEPTH_USDT, 25, 1000000);
  const found = [];
  for (let i = 0; i < venues.length; i++) for (let j = 0; j < venues.length; j++) {
    if (i === j) continue;
    const buyVenue = venues[i], sellVenue = venues[j];
    const buyFee = setting(env[buyVenue.exchange.fee], 0.1, 5);
    const sellFee = setting(env[sellVenue.exchange.fee], 0.1, 5);
    for (const [symbol, buy] of buyVenue.markets) {
      const sell = sellVenue.markets.get(symbol);
      if (!sell) continue;
      const depth = Math.min(buy.ask * buy.askQty, sell.bid * sell.bidQty);
      if (!Number.isFinite(depth) || depth < minDepth) continue;
      const gross = (sell.bid / buy.ask - 1) * 100;
      const net = (sell.bid * (1 - sellFee / 100) / (buy.ask * (1 + buyFee / 100)) - 1) * 100;
      if (Number.isFinite(net) && net >= minNet) found.push({
        symbol, buyExchange: buyVenue.exchange.id, sellExchange: sellVenue.exchange.id,
        buy: buy.ask, sell: sell.bid, gross, net, depth, buyFee, sellFee
      });
    }
  }
  found.sort((a, b) => b.net - a.net);
  return { opportunities: found.slice(0, 8), exchanges: venues.map(x => x.exchange.id), errors };
}

async function tg(env, method, body) {
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}
const keyboard = { inline_keyboard: [
  [{text:"🔎 Сканировать рынок",callback_data:"scan"}],
  [{text:"🔔 Подписаться",callback_data:"subscribe"},{text:"🔕 Отписаться",callback_data:"unsubscribe"}],
  [{text:"🧪 Демо-балансы",callback_data:"demo"}],
  [{text:"🟢 Арби — демо-сделка",callback_data:"arbi_demo"},{text:"🔵 Трейдинг — сигнал",callback_data:"trade"}],
  [{text:"ℹ️ Помощь",callback_data:"help"}]
]};
async function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true,...extra});
}
function help() {
  return "🧭 <b>A|MORE</b>\n\n/demo — показать демо-балансы\n/demo_reset — сбросить оба виртуальных счёта\n/scan — сканировать рынок\n/subscribe — включить сигналы\n/unsubscribe — отключить сигналы\n/help — помощь\n\nАрби ищет расчётные межбиржевые расхождения. Демо-счета пока служат учётной основой для будущей симуляции сделок; сами по себе они не доказывают точность сигналов.";
}
function report(data, env) {
  const threshold = setting(env.MIN_NET_SPREAD_PERCENT, 0.25, 20);
  let out = "🟢 <b>A|MORE ARBITRAGE</b>\n<i>Spot USDT • публичные котировки</i>\n";
  out += "Биржи онлайн: <b>" + html(data.exchanges.join(", ")) + "</b>\nПорог net: <b>" + threshold.toFixed(2) + "%</b>\n\n";
  if (!data.opportunities.length) out += "Пока нет возможностей выше порога. Бот не будет придумывать сигналы.";
  for (let i = 0; i < data.opportunities.length; i++) {
    const x = data.opportunities[i];
    out += "<b>" + (i+1) + ". " + html(x.symbol.replace("USDT","/USDT")) + "</b>\n";
    out += "Купить: <b>" + price(x.buy) + "</b> • " + html(x.buyExchange) + "\n";
    out += "Продать: <b>" + price(x.sell) + "</b> • " + html(x.sellExchange) + "\n";
    out += "Спред: " + x.gross.toFixed(3) + "% gross → <b>+" + x.net.toFixed(3) + "% net</b>\n";
    out += "Комиссии: " + x.buyFee.toFixed(3) + "% + " + x.sellFee.toFixed(3) + "% • глубина лучших цен: ~$" + Math.floor(x.depth).toLocaleString("en-US") + "\n\n";
  }
  if (data.errors.length) out += "⚠️ Биржи с ошибкой: " + html(data.errors.join("; ")) + "\n";
  out += "\n<i>Не учитывает вывод, перевод, проскальзывание, задержки и ограничения аккаунта. Проверяй стакан перед любой сделкой.</i>";
  return out;
}
async function runScan(env, chatId) {
  await send(env, chatId, "⏳ Получаю котировки Binance, Bybit и OKX…");
  try { const data = await scan(env); await send(env, chatId, report(data, env), {reply_markup:keyboard}); }
  catch (e) { await send(env, chatId, "⚠️ Сканирование не завершено: " + html(e.message), {reply_markup:keyboard}); }
}
async function handle(update, env) {
  const msg = update.message, cb = update.callback_query;
  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chatId) return;
  if (cb) await tg(env, "answerCallbackQuery", {callback_query_id:cb.id});
  const command = (msg?.text || "").trim().split(/\s+/)[0].toLowerCase();
  const action = cb?.data;
  if (command === "/demo" || action === "demo") {
    try {
      const account = await getDemoAccount(env, chatId);
      await send(env, chatId, formatDemoAccount(account), {reply_markup:{inline_keyboard:[
        [{text:"♻️ Сбросить оба баланса",callback_data:"demo_reset"}],
        [{text:"⬅️ Главное меню",callback_data:"help"}]
      ]}});
    } catch (e) { await send(env, chatId, "⚠️ Демо-счёт недоступен: " + html(e.message)); }
  } else if (command === "/demo_reset" || action === "demo_reset") {
    try {
      const account = await resetDemoAccount(env, chatId);
      await send(env, chatId, "♻️ Оба виртуальных счёта сброшены до 1 000 USDT.\n\n" + formatDemoAccount(account), {reply_markup:keyboard});
    } catch (e) { await send(env, chatId, "⚠️ Не удалось сбросить демо-счета: " + html(e.message)); }
  } else if (command === "/trade" || action === "trade") {
    await send(env, chatId, "🔎 Анализирую закрытые минутные свечи BTC, ETH, SOL, BNB и XRP…");
    try {
      const result = await openTradingDemo(env, chatId);
      if (result.active) await send(env, chatId, "У тебя уже есть активный прогноз:\n\n" + formatOpenTrade(result.active));
      else if (result.none) await send(env, chatId, "⏸ <b>Трейдинг: сигнала нет.</b>\nУсловия стратегии не совпали. Не открываю виртуальную сделку ради количества.");
      else await send(env, chatId, formatOpenTrade(result.trade));
    } catch (e) { await send(env, chatId, "⚠️ Не удалось открыть демо-прогноз: " + html(e.message)); }
  } else if (command === "/arbi_demo" || action === "arbi_demo") {
    await send(env, chatId, "🔎 Арби проверяет текущие межбиржевые котировки…");
    try {
      const account = await getDemoAccount(env, chatId);
      const stake = 100;
      if (account.arbi.balance < stake) throw new Error("На демо-балансе Арби недостаточно средств.");
      const data = await scan(env);
      const best = data.opportunities[0];
      if (!best) await send(env, chatId, "⏸ <b>Арби: возможности нет.</b> Не открываю виртуальную сделку без положительного расчётного net-спреда.");
      else {
        const pnl = Number((stake * best.net / 100).toFixed(8));
        const updated = await applyDemoResult(env, chatId, "arbi", pnl, "win");
        await send(env, chatId, "🟢 <b>АРБИ — ДЕМО-СДЕЛКА ЗАПИСАНА</b>\nПара: <b>" + html(best.symbol) + "</b>\nКупить: " + price(best.buy) + " • " + html(best.buyExchange) + "\nПродать: " + price(best.sell) + " • " + html(best.sellExchange) + "\nВиртуальный объём: " + stake.toFixed(2) + " USDT\nРасчётный net: +" + best.net.toFixed(3) + "%\nМодельный P/L: <b>+" + pnl.toFixed(4) + " USDT</b>\nБаланс Арби: <b>" + updated.arbi.balance.toFixed(2) + " USDT</b>\n\n<i>Это расчёт по лучшим котировкам, не подтверждённое исполнение двух ордеров. Реальные комиссии, глубина и проскальзывание могут изменить результат.</i>");
      }
    } catch (e) { await send(env, chatId, "⚠️ Демо-скан Арби не завершён: " + html(e.message)); }
  } else if (["/start","/help"].includes(command) || action === "help") {
    await send(env, chatId, "⚡ <b>Добро пожаловать в A|MORE ARBITRAGE</b>\nСканер межбиржевых расхождений цен.\n\n" + help(), {reply_markup:keyboard});
  } else if (command === "/scan" || action === "scan") await runScan(env, chatId);
  else if (command === "/subscribe" || action === "subscribe") {
    if (!env.SUBSCRIBERS) await send(env, chatId, "Хранилище подписок пока не подключено. Используй /scan.");
    else { await env.SUBSCRIBERS.put("chat:" + chatId, "1"); await send(env, chatId, "🔔 Подписка включена.", {reply_markup:keyboard}); }
  } else if (command === "/unsubscribe" || action === "unsubscribe") {
    if (env.SUBSCRIBERS) await env.SUBSCRIBERS.delete("chat:" + chatId);
    await send(env, chatId, "🔕 Автоматические сигналы отключены.", {reply_markup:keyboard});
  } else await send(env, chatId, "Не понял команду. Отправь /help.", {reply_markup:keyboard});
}
async function scheduled(env) {
  if (!env.SUBSCRIBERS) return;
  const list = await env.SUBSCRIBERS.list({prefix:"chat:",limit:1000});
  if (!list.keys.length) return;
  let data;
  try { data = await scan(env); } catch (e) { console.error("Scheduled scan:",e); return; }
  for (const x of data.opportunities) {
    const key = "alert:" + x.symbol + ":" + x.buyExchange + ":" + x.sellExchange;
    if (await env.SUBSCRIBERS.get(key)) continue;
    await env.SUBSCRIBERS.put(key,"1",{expirationTtl:300});
    const message = "🚨 <b>A|MORE — новая возможность</b>\n<b>" + html(x.symbol) + "</b>\nКупить: " + price(x.buy) + " • " + html(x.buyExchange) + "\nПродать: " + price(x.sell) + " • " + html(x.sellExchange) + "\nРасчётный net: <b>+" + x.net.toFixed(3) + "%</b>\n<i>Проверь стакан, комиссии, лимиты и возможность перевода.</i>";
    await Promise.allSettled(list.keys.map(k => send(env,k.name.slice(5),message,{reply_markup:keyboard})));
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ok:true,service:"A|More Arbitrage",version:"0.1.0"});
    if (request.method !== "POST" || !env.WEBHOOK_PATH_SECRET || url.pathname !== "/telegram/" + env.WEBHOOK_PATH_SECRET) return new Response("Not found",{status:404});
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized",{status:401});
    let update;
    try { update = await request.json(); } catch { return new Response("Bad Request",{status:400}); }
    try { await handle(update,env); } catch (e) { console.error("Telegram update:",e); }
    return new Response("ok");
  },
  async scheduled(_event,env,ctx) { ctx.waitUntil(scheduled(env)); }
};
