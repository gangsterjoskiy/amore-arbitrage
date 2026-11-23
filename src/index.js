import { getDemoAccount, getDemoHistory, resetDemoAccount, formatDemoAccount, applyDemoResult } from "./demo.js";
import { readAutoPaper, startAutoPaper, stopAutoPaper, recordAutoPaperTrade, getAutoPaperDailyCount, writeAutoPaper, calculateTriangularOpportunities } from "./auto-paper.js";
import { openTradingDemo, settleTradingDemos, formatOpenTrade, TIMEFRAMES } from "./paper.js";


const EXCHANGES = [
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

const KRAKEN_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
async function getGateMarkets() {
  const base = "https://api.gateio.ws/api/v4";
  const symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
  const tickersResponse = await fetch(base + "/spot/tickers", {headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
  if (!tickersResponse.ok) throw new Error("Gate.io tickers HTTP " + tickersResponse.status);
  const tickers = await tickersResponse.json();
  if (!Array.isArray(tickers)) throw new Error("Gate.io: некорректный ответ тикеров");
  const tickerMap = new Map(tickers.filter(x => x.currency_pair).map(x => [x.currency_pair.replace("_",""),x]));
  const results = await Promise.allSettled(symbols.map(async symbol => {
    const pair = symbol.replace("USDT","_USDT");
    const ticker = tickerMap.get(symbol);
    if (!ticker) throw new Error("Gate.io: нет пары " + pair);
    const response = await fetch(base + "/spot/order_book?currency_pair=" + pair + "&limit=1", {headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if (!response.ok) throw new Error("Gate.io order book " + pair + " HTTP " + response.status);
    const book = await response.json();
    const bid = Number(book.bids?.[0]?.[0]), bidQty = Number(book.bids?.[0]?.[1]);
    const ask = Number(book.asks?.[0]?.[0]), askQty = Number(book.asks?.[0]?.[1]);
    const last = Number(ticker.last), change = Number(ticker.change_percentage);
    if (![bid,bidQty,ask,askQty,last].every(Number.isFinite) || bid<=0 || ask<=0 || ask<bid || bidQty<=0 || askQty<=0) throw new Error("Gate.io: некорректный стакан " + pair);
    const open = Number.isFinite(change) && 1 + change/100 > 0 ? last / (1 + change/100) : null;
    return {symbol,bid,ask,bidQty,askQty,last,open};
  }));
  const markets = new Map();
  const errors = [];
  for (let i=0;i<results.length;i++) {
    const result=results[i];
    if(result.status==="fulfilled") markets.set(symbols[i],result.value);
    else errors.push(String(result.reason?.message || result.reason));
  }
  if (!markets.size) throw new Error(errors.join("; ") || "Gate.io: нет пригодных рынков");
  return {exchange:{id:"Gate.io",fee:"GATEIO_TAKER_FEE"},markets,errors};
}
async function getKrakenMarkets() {
  const pairResponse = await fetch("https://api.kraken.com/0/public/AssetPairs", {headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
  if (!pairResponse.ok) throw new Error("Kraken AssetPairs HTTP " + pairResponse.status);
  const pairPayload = await pairResponse.json();
  if (pairPayload.error?.length) throw new Error("Kraken: " + pairPayload.error.join(", "));
  const wanted = new Set(KRAKEN_SYMBOLS);
  const pairs = Object.entries(pairPayload.result || {}).filter(([,info]) => {
    const normalized = String(info.altname || "").replace("XBT","BTC").replace("/","");
    return wanted.has(normalized) && info.status !== "cancel_only" && info.status !== "post_only";
  });
  if (!pairs.length) throw new Error("Kraken: нет общих USDT-пар");
  const tickerUrl = "https://api.kraken.com/0/public/Ticker?pair=" + pairs.map(([key]) => encodeURIComponent(key)).join(",");
  const tickerResponse = await fetch(tickerUrl,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
  if (!tickerResponse.ok) throw new Error("Kraken Ticker HTTP " + tickerResponse.status);
  const tickerPayload = await tickerResponse.json();
  if (tickerPayload.error?.length) throw new Error("Kraken: " + tickerPayload.error.join(", "));
  const markets = new Map(), tickers = [];
  for (const [key,info] of pairs) {
    const row = tickerPayload.result?.[key];
    if (!row) continue;
    const symbol = String(info.altname || "").replace("XBT","BTC").replace("/","");
    const bid = Number(row.b?.[0]), ask = Number(row.a?.[0]);
    const bidQty = Number(row.b?.[1]), askQty = Number(row.a?.[1]);
    const last = Number(row.c?.[0]), open = Number(row.o);
    if (!wanted.has(symbol) || ![bid,ask,bidQty,askQty,last].every(Number.isFinite) || bid<=0 || ask<=0 || ask<bid) continue;
    markets.set(symbol,{symbol,bid,ask,bidQty,askQty,last,open});
    tickers.push({symbol,price:last,change:Number.isFinite(open)&&open>0?(last/open-1)*100:null});
  }
  if (!markets.size) throw new Error("Kraken: не удалось получить пригодные USDT-котировки");
  return {exchange:{id:"Kraken",fee:"KRAKEN_TAKER_FEE"},markets,tickers};
}
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

function marketTickerSnapshot(venues) {
  return KRAKEN_SYMBOLS.map(symbol => {
    const venue = venues.find(x => x.exchange.id === "Kraken" && x.markets.has(symbol)) || venues.find(x => x.markets.has(symbol));
    if (!venue) return null;
    const market = venue.markets.get(symbol);
    const price = Number.isFinite(market.last) ? market.last : (market.bid + market.ask) / 2;
    const change = Number.isFinite(market.change) ? market.change : Number.isFinite(market.open) && market.open > 0 ? (price / market.open - 1) * 100 : null;
    return {symbol,price,change,source:venue.exchange.id};
  }).filter(x => x && Number.isFinite(x.price) && x.price > 0);
}
async function scan(env) {
  const settled = await Promise.allSettled([...EXCHANGES.map(getMarkets), getKrakenMarkets(), getGateMarkets()]);
  const venues = settled.filter(x => x.status === "fulfilled").map(x => x.value);
  const errors = settled.flatMap(x => x.status === "rejected" ? [String(x.reason?.message || x.reason)] : (x.value.errors || []));
  if (venues.length < 2) {
    const kraken = venues.find(x => x.exchange.id === "Kraken");
    return {opportunities:[],exchanges:venues.map(x=>x.exchange.id),errors,diagnostics:{sharedPairs:0,depthRejected:0,bestBeforeThreshold:null,minNet:setting(env.MIN_NET_SPREAD_PERCENT,0.25,20),minDepth:setting(env.MIN_TOP_OF_BOOK_DEPTH_USDT,25,1000000)},marketTickers:marketTickerSnapshot(venues),scanAvailable:false};
  }
  const minNet = setting(env.MIN_NET_SPREAD_PERCENT, 0.25, 20);
  const minDepth = setting(env.MIN_TOP_OF_BOOK_DEPTH_USDT, 25, 1000000);
  const found = [];
  const rawBest = [];
  let sharedPairs = 0, depthRejected = 0;
  for (let i = 0; i < venues.length; i++) for (let j = 0; j < venues.length; j++) {
    if (i === j) continue;
    const buyVenue = venues[i], sellVenue = venues[j];
    const buyFee = setting(env[buyVenue.exchange.fee], buyVenue.exchange.id === "Gate.io" ? 0.2 : 0.1, 5);
    const sellFee = setting(env[sellVenue.exchange.fee], sellVenue.exchange.id === "Gate.io" ? 0.2 : 0.1, 5);
    for (const [symbol, buy] of buyVenue.markets) {
      const sell = sellVenue.markets.get(symbol);
      if (!sell) continue;
      sharedPairs++;
      const depth = Math.min(buy.ask * buy.askQty, sell.bid * sell.bidQty);
      const gross = (sell.bid / buy.ask - 1) * 100;
      const net = (sell.bid * (1 - sellFee / 100) / (buy.ask * (1 + buyFee / 100)) - 1) * 100;
      const candidate = {symbol,buyExchange:buyVenue.exchange.id,sellExchange:sellVenue.exchange.id,buy:buy.ask,sell:sell.bid,gross,net,depth,buyFee,sellFee};
      if (!Number.isFinite(depth) || depth < minDepth) { depthRejected++; continue; }
      if (Number.isFinite(net)) rawBest.push(candidate);
      if (Number.isFinite(net) && net >= minNet) found.push({
        symbol, buyExchange: buyVenue.exchange.id, sellExchange: sellVenue.exchange.id,
        buy: buy.ask, sell: sell.bid, gross, net, depth, buyFee, sellFee
      });
    }
  }
  found.sort((a, b) => b.net - a.net);
  rawBest.sort((a,b) => b.net-a.net);
  return {
    opportunities: found.slice(0, 8), exchanges: venues.map(x => x.exchange.id), errors,
    diagnostics: {sharedPairs,depthRejected,bestBeforeThreshold:rawBest[0] || null,minNet,minDepth},
    marketTickers:marketTickerSnapshot(venues),scanAvailable:true
  };
}

async function fetchOrderBookJson(url, label) {
  const response = await fetch(url, {headers:{accept:"application/json"},signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error(label + " HTTP " + response.status);
  return response.json();
}
function cleanBookLevels(levels) {
  return (Array.isArray(levels) ? levels : []).map(x => Array.isArray(x) ? [Number(x[0]),Number(x[1])] : [Number(x?.p),Number(x?.s)])
    .filter(([price,qty]) => Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0);
}
async function getExecutionOrderBook(exchange, symbol) {
  if (exchange === "Bybit") {
    const data = await fetchOrderBookJson("https://api.bybit.com/v5/market/orderbook?category=spot&symbol="+encodeURIComponent(symbol)+"&limit=50","Bybit order book");
    if (data.retCode !== 0) throw new Error(data.retMsg || "Bybit order book error");
    return {asks:cleanBookLevels(data.result?.a),bids:cleanBookLevels(data.result?.b)};
  }
  if (exchange === "OKX") {
    const instrument = symbol.replace("USDT","-USDT");
    const data = await fetchOrderBookJson("https://www.okx.com/api/v5/market/books?instId="+encodeURIComponent(instrument)+"&sz=50","OKX order book");
    if (data.code !== "0" || !data.data?.[0]) throw new Error(data.msg || "OKX order book error");
    return {asks:cleanBookLevels(data.data[0].asks),bids:cleanBookLevels(data.data[0].bids)};
  }
  if (exchange === "Gate.io") {
    const pair = symbol.replace("USDT","_USDT");
    const data = await fetchOrderBookJson("https://api.gateio.ws/api/v4/spot/order_book?currency_pair="+encodeURIComponent(pair)+"&limit=50","Gate.io order book");
    return {asks:cleanBookLevels(data.asks),bids:cleanBookLevels(data.bids)};
  }
  if (exchange === "Kraken") {
    const payload = await fetchOrderBookJson("https://api.kraken.com/0/public/AssetPairs","Kraken asset pairs");
    if (payload.error?.length) throw new Error(payload.error.join(", "));
    const normalized = symbol.replace("BTC","XBT");
    const pair = Object.entries(payload.result || {}).find(([,info]) =>
      String(info.altname || "").replace("/","") === normalized || String(info.altname || "").replace("/","") === symbol
    )?.[0];
    if (!pair) throw new Error("Kraken: пара " + symbol + " не найдена");
    const book = await fetchOrderBookJson("https://api.kraken.com/0/public/Depth?pair="+encodeURIComponent(pair)+"&count=50","Kraken order book");
    if (book.error?.length) throw new Error(book.error.join(", "));
    const row = Object.values(book.result || {})[0];
    return {asks:cleanBookLevels(row?.asks),bids:cleanBookLevels(row?.bids)};
  }
  throw new Error("Неподдерживаемая биржа для демо-исполнения: " + exchange);
}
function consumeAskBook(asks, quoteBudget) {
  let remaining = quoteBudget, quantity = 0, quoteSpent = 0;
  for (const [price,available] of asks) {
    const take = Math.min(available,remaining/price);
    if (take <= 0) continue;
    quantity += take;
    quoteSpent += take*price;
    remaining -= take*price;
    if (remaining <= quoteBudget*1e-10) break;
  }
  if (remaining > quoteBudget*1e-6 || quantity <= 0) throw new Error("Недостаточная глубина ask для полного виртуального объёма покупки");
  return {quantity,quoteSpent,averagePrice:quoteSpent/quantity};
}
function consumeBidBook(bids, quantity) {
  let remaining = quantity, quoteReceived = 0, sold = 0;
  for (const [price,available] of bids) {
    const take = Math.min(available,remaining);
    if (take <= 0) continue;
    sold += take;
    quoteReceived += take*price;
    remaining -= take;
    if (remaining <= quantity*1e-10) break;
  }
  if (remaining > quantity*1e-6 || sold <= 0) throw new Error("Недостаточная глубина bid для полного виртуального объёма продажи");
  return {quantity:sold,quoteReceived,averagePrice:quoteReceived/sold};
}
async function executeArbitragePaper(env, chatId, opportunity, quoteBudget = 100) {
  const account = await getDemoAccount(env, chatId);
  if (account.arbi.balance < quoteBudget) throw new Error("На демо-балансе A|MORE Arbitrage недостаточно средств.");
  const [buyBook,sellBook] = await Promise.all([
    getExecutionOrderBook(opportunity.buyExchange,opportunity.symbol),
    getExecutionOrderBook(opportunity.sellExchange,opportunity.symbol)
  ]);
  const buy = consumeAskBook(buyBook.asks,quoteBudget);
  const sell = consumeBidBook(sellBook.bids,buy.quantity);
  const feeFor = exchange => setting(env[({Bybit:"BYBIT_TAKER_FEE",OKX:"OKX_TAKER_FEE",Kraken:"KRAKEN_TAKER_FEE","Gate.io":"GATEIO_TAKER_FEE"})[exchange]],exchange==="Gate.io"?0.2:0.1,5);
  const buyFee = feeFor(opportunity.buyExchange), sellFee = feeFor(opportunity.sellExchange);
  const buyCost = buy.quoteSpent*(1+buyFee/100);
  const sellProceeds = sell.quoteReceived*(1-sellFee/100);
  const pnl = Number((sellProceeds-buyCost).toFixed(8));
  const outcome = pnl > 0.00000001 ? "win" : pnl < -0.00000001 ? "loss" : "draw";
  const updated = await applyDemoResult(env,chatId,"arbi",pnl,outcome,{
    type:"arbitrage_paper_execution",symbol:opportunity.symbol,buyExchange:opportunity.buyExchange,sellExchange:opportunity.sellExchange,
    quoteBudget,quantity:buy.quantity,buyAverage:buy.averagePrice,sellAverage:sell.averagePrice,
    buyFee,sellFee,buyCost,sellProceeds,net:opportunity.net,pnl
  });
  return {buy,sell,buyFee,sellFee,buyCost,sellProceeds,pnl,outcome,balance:updated.arbi.balance,quantity:buy.quantity,quoteBudget};
}

async function scanTriangular(env) {
  const payload = await fetchOrderBookJson("https://api.bybit.com/v5/market/tickers?category=spot", "Bybit spot tickers");
  if (payload.retCode !== 0 || !Array.isArray(payload.result?.list)) throw new Error(payload.retMsg || "Bybit triangular ticker response error");
  return calculateTriangularOpportunities(payload.result.list, {
    feePercent: setting(env.BYBIT_TAKER_FEE, 0.1, 5),
    minNetPercent: setting(env.MIN_TRI_NET_SPREAD_PERCENT, 0.25, 20),
    minDepthUsdt: setting(env.MIN_TOP_OF_BOOK_DEPTH_USDT, 25, 1000000)
  });
}
async function executeTriangularPaper(env, chatId, opportunity, quoteBudget = 100) {
  const account = await getDemoAccount(env, chatId);
  if (account.arbi.balance < quoteBudget) throw new Error("На демо-балансе A|MORE Arbitrage недостаточно средств.");
  if (opportunity.exchange !== "Bybit") throw new Error("Треугольный PAPER-маршрут пока поддерживает только Bybit.");
  const asset = opportunity.asset;
  const [btcUsdtBook,assetBtcBook,assetUsdtBook] = await Promise.all([
    getExecutionOrderBook("Bybit","BTCUSDT"),
    getExecutionOrderBook("Bybit",asset+"BTC"),
    getExecutionOrderBook("Bybit",asset+"USDT")
  ]);
  const fee = setting(env.BYBIT_TAKER_FEE,0.1,5);
  const feeFactor = 1-fee/100;
  if (feeFactor <= 0) throw new Error("Некорректная комиссия Bybit.");
  let finalUsdt, leg1, leg2, leg3;
  if (opportunity.direction === "USDT_BTC_ASSET_USDT") {
    leg1 = consumeAskBook(btcUsdtBook.asks,quoteBudget);
    const btcAfterFee = leg1.quantity*feeFactor;
    leg2 = consumeAskBook(assetBtcBook.asks,btcAfterFee);
    const assetAfterFee = leg2.quantity*feeFactor;
    leg3 = consumeBidBook(assetUsdtBook.bids,assetAfterFee);
    finalUsdt = leg3.quoteReceived*feeFactor;
  } else if (opportunity.direction === "USDT_ASSET_BTC_USDT") {
    leg1 = consumeAskBook(assetUsdtBook.asks,quoteBudget);
    const assetAfterFee = leg1.quantity*feeFactor;
    leg2 = consumeBidBook(assetBtcBook.bids,assetAfterFee);
    const btcAfterFee = leg2.quoteReceived*feeFactor;
    leg3 = consumeBidBook(btcUsdtBook.bids,btcAfterFee);
    finalUsdt = leg3.quoteReceived*feeFactor;
  } else throw new Error("Неизвестное направление треугольного маршрута.");
  const pnl = Number((finalUsdt-quoteBudget).toFixed(8));
  const outcome = pnl > 0.00000001 ? "win" : pnl < -0.00000001 ? "loss" : "draw";
  const updated = await applyDemoResult(env,chatId,"arbi",pnl,outcome,{
    type:"triangular_paper_execution",strategy:"triangular",symbol:opportunity.symbol,asset,
    exchange:"Bybit",buyExchange:"Bybit",sellExchange:"Bybit",route:opportunity.route,direction:opportunity.direction,
    quoteBudget,feePercent:fee,finalUsdt,pnl,estimatedNetPercent:opportunity.net,
    leg1Average:leg1.averagePrice,leg2Average:leg2.averagePrice,leg3Average:leg3.averagePrice
  });
  return {pnl,outcome,balance:updated.arbi.balance,quoteBudget,finalUsdt,feePercent:fee,route:opportunity.route};
}
async function runAutoPaperForUser(env, chatId, state, crossOpportunities, triangularOpportunities) {
  const now = Date.now();
  if (!state?.enabled) return;
  if (now >= Number(state.endsAt)) {
    await stopAutoPaper(env,chatId,"30-day-test-completed");
    try { await send(env,chatId,"🏁 <b>30-дневный PAPER-тест A|MORE завершён.</b> Новые виртуальные сделки остановлены. Открой раздел «Сделки», чтобы посмотреть итоговую статистику."); } catch {}
    return;
  }
  if (await env.SUBSCRIBERS.get("user:stop:"+chatId)) return;
  const lockKey = "auto:paper:lock:"+chatId;
  if (await env.SUBSCRIBERS.get(lockKey)) return;
  await env.SUBSCRIBERS.put(lockKey,"1",{expirationTtl:55});
  try {
    const dailyCount = await getAutoPaperDailyCount(env,chatId,now);
    if (dailyCount >= Number(state.maxTradesPerDay || 12)) return;
    const candidates = [
      ...crossOpportunities.map(x=>({...x,strategy:"cross_exchange"})),
      ...triangularOpportunities
    ].sort((a,b)=>Number(b.net)-Number(a.net));
    for (const candidate of candidates) {
      const routeKey = candidate.strategy === "triangular"
        ? candidate.direction+":"+candidate.asset
        : candidate.symbol+":"+candidate.buyExchange+":"+candidate.sellExchange;
      const cooldownKey = "auto:paper:cool:"+chatId+":"+candidate.strategy+":"+routeKey;
      if (await env.SUBSCRIBERS.get(cooldownKey)) continue;
      await env.SUBSCRIBERS.put(cooldownKey,"1",{expirationTtl:300});
      try {
        const result = candidate.strategy === "triangular"
          ? await executeTriangularPaper(env,chatId,candidate,Number(state.quoteBudget)||100)
          : await executeArbitragePaper(env,chatId,candidate,Number(state.quoteBudget)||100);
        await recordAutoPaperTrade(env,chatId,{outcome:result.outcome,pnl:result.pnl});
        const route = candidate.strategy === "triangular"
          ? candidate.route
          : candidate.buyExchange+" → "+candidate.sellExchange;
        const label = result.outcome === "win" ? "✅ ВИРТУАЛЬНАЯ СДЕЛКА В ПЛЮС" : result.outcome === "loss" ? "❌ ВИРТУАЛЬНАЯ СДЕЛКА В МИНУС" : "➖ НУЛЕВОЙ РЕЗУЛЬТАТ";
        const text = "🤖 <b>A|MORE AUTO PAPER</b>\n"+label+"\nСтратегия: <b>"+(candidate.strategy==="triangular"?"Треугольный арбитраж":"Межбиржевой арбитраж")+"</b>\nПара: <b>"+html(candidate.symbol)+"</b>\nМаршрут: "+html(route)+"\nРасчётный net до исполнения: "+Number(candidate.net).toFixed(3)+"%\nP/L после симуляции: <b>"+(result.pnl>0?"+":"")+result.pnl.toFixed(4)+" USDT</b>\nДемо-баланс: <b>"+result.balance.toFixed(2)+" USDT</b>\n<i>Только виртуальное исполнение по публичным стаканам. Реальные ордера отключены.</i>";
        try { await send(env,chatId,text); } catch (notifyError) { console.error("Auto PAPER notification:",notifyError); }
        return;
      } catch (error) {
        await env.SUBSCRIBERS.put(cooldownKey,"1",{expirationTtl:60});
        const latest = await readAutoPaper(env,chatId);
        if (latest) {
          latest.lastError = String(error?.message || error).slice(0,300);
          await writeAutoPaper(env,chatId,latest);
        }
        console.error("Auto PAPER execution:",chatId,error);
      }
    }
  } finally {
    await env.SUBSCRIBERS.delete(lockKey);
  }
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
  [{text:"◈ Открыть A|MORE Terminal",web_app:{url:"https://amore-arbitrage.hn29wknr7h.workers.dev/?v=20261123-auto-paper-1"}}],
  [{text:"📊 A|MORE Arbitrage — сканировать",callback_data:"scan"}],
  [{text:"📈 A|MORE Signals — выбрать таймфрейм",callback_data:"trade_menu"}],
  [{text:"🧠 AI Committee — быстрый AI-анализ",callback_data:"trade:ai"}],
  [{text:"💼 Демо-балансы",callback_data:"demo"},{text:"🧾 Сделки",callback_data:"deals"}],
  [{text:"📊 Статистика",callback_data:"stats"}],
  [{text:"🔔 Уведомления: включить",callback_data:"subscribe"},{text:"🔕 выключить",callback_data:"unsubscribe"}],
  [{text:"🧪 Тестовая сделка",callback_data:"arbi_demo"}],
  [{text:"ℹ️ Помощь",callback_data:"help"}]
]};
async function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true,reply_markup:keyboard,...extra});
}
async function recordAIUsage(env, chatId, committee, meta = {}) {
  const usage = committee?.usage;
  if (!usage || !Number.isFinite(Number(usage.neurons))) return false;
  const day = new Date().toISOString().slice(0,10);
  const row = {
    at:new Date().toISOString(), model:committee.model || "@cf/zai-org/glm-4.7-flash",
    promptTokens:Number(usage.promptTokens), completionTokens:Number(usage.completionTokens),
    totalTokens:Number(usage.totalTokens), neurons:Number(usage.neurons),
    latencyMs:Number(committee.latencyMs) || null,
    symbol:meta.symbol || null, direction:meta.direction || committee.verdict?.direction || null
  };
  const key = "ai:usage:" + chatId + ":" + day + ":" + Date.now() + ":" + crypto.randomUUID();
  await env.SUBSCRIBERS.put(key,JSON.stringify(row),{expirationTtl:60*60*24*45});
  return true;
}
function help() {
  return "🧭 <b>A|MORE — главное меню</b>\n\n<b>📊 A|MORE Arbitrage</b> — сравнение цен на спотовых биржах и расчёт net-спреда.\n<b>📈 A|MORE Signals</b> — алгоритмический анализ минутных свечей. <b>🧠 AI Committee</b> — четыре аналитические роли и главный арбитр.\n<b>💼 Демо-балансы</b> — отдельные виртуальные счета двух модулей.\n<b>🧾 Статистика</b> — результаты тестирования.\n\nВсе сделки виртуальные. Межбиржевой спред не означает, что ордера реально исполнимы. Точность сигналов не подтверждена статистически. Для управления используй кнопки меню ниже.";
}
function minDepthFallback(env) { return setting(env.MIN_TOP_OF_BOOK_DEPTH_USDT,25,1000000); }
function report(data, env) {
  const threshold = setting(env.MIN_NET_SPREAD_PERCENT, 0.25, 20);
  let out = "🟢 <b>A|MORE ARBITRAGE</b>\n<i>Spot USDT • публичные котировки</i>\n";
  out += "Биржи онлайн: <b>" + html(data.exchanges.join(", ")) + "</b>\nПорог net: <b>" + threshold.toFixed(2) + "%</b>\n\n";
  if (!data.opportunities.length) {
    const d = data.diagnostics || {};
    out += "Пока нет возможностей выше порога. Бот не будет придумывать сигналы.\n\n";
    out += "Совпадающих пар между биржами: <b>" + (d.sharedPairs ?? 0) + "</b>\n";
    out += "Отсеяно по глубине стакана: <b>" + (d.depthRejected ?? 0) + "</b> (минимум ~$" + (d.minDepth ?? minDepthFallback(env)) + ")\n";
    if (d.bestBeforeThreshold) {
      const b=d.bestBeforeThreshold;
      out += "Лучший net до фильтра: <b>" + b.net.toFixed(3) + "%</b> — " + html(b.symbol) + " (" + html(b.buyExchange) + " → " + html(b.sellExchange) + ")\n";
      out += "До заданного порога не хватает " + Math.max(0,d.minNet-b.net).toFixed(3) + " п.п.\n";
    } else out += "Не удалось получить пригодную общую пару с корректными котировками.\n";
  }
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
  await send(env, chatId, "⏳ Получаю котировки доступных спотовых бирж…");
  try {
    const data = await scan(env);
    const tradeRows = data.opportunities.slice(0,5).map(x => [{text:"💱 Сделка "+x.symbol+" · демо",callback_data:"arbi_trade:"+x.symbol+":"+x.buyExchange+":"+x.sellExchange}]);
    const reply_markup = {inline_keyboard:[...tradeRows,[{text:"🔄 Обновить сканирование",callback_data:"scan"}],[{text:"⬅️ Главное меню",callback_data:"help"}]]};
    await send(env, chatId, report(data, env), {reply_markup:tradeRows.length?reply_markup:keyboard});
  } catch (e) { await send(env, chatId, "⚠️ Сканирование не завершено: " + html(e.message), {reply_markup:keyboard}); }
}
async function telegramMiniAppUser(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data") || "";
  if (!initData || !env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram авторизация недоступна. Открой Mini App из Telegram.");
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!receivedHash || !Number.isFinite(authDate) || Math.abs(Date.now()/1000-authDate) > 86400) throw new Error("Сессия Telegram устарела. Закрой и снова открой Mini App.");
  const checkString = [...params.entries()].filter(([key]) => key !== "hash").sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,value]) => key + "=" + value).join("\n");
  const encoder = new TextEncoder();
  const secretBase = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", secretBase, encoder.encode(env.TELEGRAM_BOT_TOKEN));
  const signingKey = await crypto.subtle.importKey("raw", secret, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(checkString)));
  const calculatedHash = Array.from(signature).map(x => x.toString(16).padStart(2,"0")).join("");
  if (calculatedHash.length !== receivedHash.length) throw new Error("Не удалось подтвердить Telegram-сессию.");
  let mismatch = 0;
  for (let i=0;i<calculatedHash.length;i++) mismatch |= calculatedHash.charCodeAt(i) ^ receivedHash.charCodeAt(i);
  if (mismatch) throw new Error("Не удалось подтвердить Telegram-сессию.");
  let user;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  if (!user || !Number.isInteger(Number(user.id))) throw new Error("Telegram не передал ID пользователя.");
  return Number(user.id);
}
async function dashboard(env) {
  const scanResult = await Promise.allSettled([scan(env)]);
  const scanData = scanResult[0].status === "fulfilled" ? scanResult[0].value : {
    opportunities: [], exchanges: [], errors: [String(scanResult[0].reason?.message || scanResult[0].reason)],
    diagnostics: {sharedPairs:0,depthRejected:0,bestBeforeThreshold:null,minNet:setting(env.MIN_NET_SPREAD_PERCENT,0.25,20),minDepth:minDepthFallback(env)},marketTickers:[],scanAvailable:false
  };
  const tickers = scanData.marketTickers || [];
  return {...scanData,tickers,errors:scanData.errors||[],marketStatus:tickers.length ? "live" : "offline",scanStatus:scanData.scanAvailable === false ? "unavailable" : "live"};
}
async function handle(update, env) {
  const msg = update.message, cb = update.callback_query;
  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chatId) return;
  if (cb) await tg(env, "answerCallbackQuery", {callback_query_id:cb.id});
  const command = (msg?.text || "").trim().split(/\s+/)[0].toLowerCase();
  let webAction, webAssetType="forex";
  if (msg?.web_app_data?.data) {
    try {
      const payload = JSON.parse(msg.web_app_data.data);
      if (payload.action === "signal_analysis" && ["1m","3m","5m","auto"].includes(payload.timeframe)) { webAction = "trade:" + payload.timeframe + ":" + (payload.pair || "ALL"); webAssetType = payload.assetType || "forex"; }
    } catch {}
  }
  const startArg = command === "/start" ? (msg?.text || "").trim().split(/\s+/)[1] : null;
  if (!webAction && startArg?.startsWith("signals_")) {
    const parts = startArg.slice(8).split("_");
    const requested = parts[0];
    const pair = parts[1] || "ALL";
    const allowedPairs = ["ALL","EURUSD","AUDCAD","AUDCHF","AUDJPY","AUDUSD","CADCHF","CADJPY","CHFJPY","EURAUD","EURCAD","EURCHF","EURGBP","EURJPY","GBPAUD","GBPCAD","GBPCHF","GBPJPY","GBPUSD","USDCAD","USDCHF","USDJPY","BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
    if (["1m","3m","5m","auto"].includes(requested) && allowedPairs.includes(pair)) webAction = "trade:" + requested + ":" + pair;
  }
  if (!webAction && ["stop","resume","demo","stats","deals","scan","help","demo_reset","arbi_demo"].includes(startArg)) webAction = startArg;
  const action = cb?.data || webAction;
  if (command === "/stop" || startArg === "stop" || action === "stop") {
    await env.SUBSCRIBERS.put("user:stop:" + chatId, "1");
    await env.SUBSCRIBERS.delete("chat:" + chatId);
    await stopAutoPaper(env,chatId,"global-stop");
    await send(env, chatId, "🛑 <b>A|MORE STOP включён.</b> Новые демо-прогнозы и автоматические уведомления для этого аккаунта приостановлены. Уже открытый виртуальный прогноз будет рассчитан по экспирации.", {reply_markup:{inline_keyboard:[[{text:"▶️ Возобновить работу",callback_data:"resume"}],[{text:"💼 Демо-счёт",callback_data:"demo"}]]}});
  } else if (command === "/resume" || startArg === "resume" || action === "resume") {
    await env.SUBSCRIBERS.delete("user:stop:" + chatId);
    await send(env, chatId, "▶️ <b>A|MORE возобновлён.</b> Новые демо-прогнозы снова доступны. Уведомления можно включить отдельно.", {reply_markup:keyboard});
  } else if (command === "/demo" || action === "demo") {
    try {
      const account = await getDemoAccount(env, chatId);
      await send(env, chatId, formatDemoAccount(account), {reply_markup:{inline_keyboard:[
        [{text:"♻️ Сбросить оба баланса",callback_data:"demo_reset"}],
        [{text:"⬅️ Главное меню",callback_data:"help"}]
      ]}});
    } catch (e) { await send(env, chatId, "⚠️ Демо-счёт недоступен: " + html(e.message)); }
  } else if (command === "/demo_reset" || action === "demo_reset") {
    try {
      await stopAutoPaper(env,chatId,"demo-reset");
      const account = await resetDemoAccount(env, chatId);
      await send(env, chatId, "♻️ Оба виртуальных счёта сброшены до 1 000 USDT.\n\n" + formatDemoAccount(account), {reply_markup:keyboard});
    } catch (e) { await send(env, chatId, "⚠️ Не удалось сбросить демо-счета: " + html(e.message)); }
  } else if (command === "/deals" || action === "deals") {
    const history = await getDemoHistory(env,chatId);
    const rows = history.slice(0,10).map((x,i) => {
      const win = x.outcome === "win", draw = x.outcome === "draw";
      const label = draw ? "➖" : win ? "✅" : "❌";
      const strategy = x.type === "triangular_paper_execution" ? "Треугольный" : x.bot === "trading" ? "Signals" : "Межбиржевой";
      const route = x.route || (x.buyExchange && x.sellExchange ? x.buyExchange+" → "+x.sellExchange : x.direction || "—");
      const pnl = Number(x.pnl)||0;
      return (i+1)+". "+label+" <b>"+strategy+" · "+html(x.symbol||"—")+"</b>\n   "+html(route)+" · "+(pnl>0?"+":"")+pnl.toFixed(4)+" USDT";
    });
    await send(env,chatId,"🧾 <b>A|MORE — ПОСЛЕДНИЕ СДЕЛКИ</b>\n\n"+(rows.join("\n\n")||"Пока нет завершённых операций.")+"\n\n<i>Полная история и фильтры доступны в A|MORE Terminal → «Сделки».</i>");
  } else if (command === "/stats" || action === "stats") {
    const account = await getDemoAccount(env, chatId);
    const a = account.arbi, t = account.trading;
    const pct = w => (w.wins + w.losses) ? (w.wins / (w.wins + w.losses) * 100).toFixed(1) + "%" : "пока нет данных";
    const usageDay = new Date().toISOString().slice(0,10);
    const usageKeys = await env.SUBSCRIBERS.list({prefix:"ai:usage:"+chatId+":"+usageDay+":",limit:1000});
    let aiRequests=0,aiNeurons=0,aiPrompt=0,aiCompletion=0;
    for(const key of usageKeys.keys){const raw=await env.SUBSCRIBERS.get(key.name);if(!raw)continue;try{const row=JSON.parse(raw);aiRequests++;aiNeurons+=Number(row.neurons)||0;aiPrompt+=Number(row.promptTokens)||0;aiCompletion+=Number(row.completionTokens)||0;}catch{}}
    await send(env, chatId, "📊 <b>A|MORE — СТАТИСТИКА ДЕМО</b>\n\n<b>A|MORE Arbitrage</b>\nРасчётных сделок: " + a.trades + "\nМодельный P/L: " + (a.pnl > 0 ? "+" : "") + a.pnl.toFixed(2) + " USDT\n\n<b>A|MORE Signals</b>\nПрогнозов: " + t.trades + "\nУспешных: " + t.wins + " • Неуспешных: " + t.losses + " • Ничьих: " + t.draws + "\nДоля успешных: " + pct(t) + "\nP/L: " + (t.pnl > 0 ? "+" : "") + t.pnl.toFixed(2) + " USDT\n\n<b>AI Committee сегодня</b>\nЗапросов с учтённым расходом: " + aiRequests + "\nТокены: " + aiPrompt + " вход / " + aiCompletion + " выход\nРасход: " + aiNeurons.toFixed(2) + " / 10 000 Neurons\n\n<i>Учёт по usage-метаданным ответа модели; таймауты без ответа могут не попасть в счётчик. Демо-статистика не доказывает преимущество стратегии.</i>");
  } else if (action === "trade_menu") {
    await send(env, chatId, "📈 <b>A|MORE Signals</b>\nВыбери период свечей. В режиме «Авто» бот проверит M1/M3/M5 и потребует совпадения минимум двух периодов. В Telegram по умолчанию анализируется EURUSD; другой актив выбери в A|MORE Terminal.", {reply_markup:{inline_keyboard:[[{text:"⚡ ATM · быстрый прогноз",callback_data:"trade:atm"}],[{text:"⚡ M1 · 1 мин",callback_data:"trade:1m"},{text:"🎯 M3 · 3 мин",callback_data:"trade:3m"},{text:"🎯 M5 · 5 мин",callback_data:"trade:5m"}],[{text:"🤖 Авто · все периоды",callback_data:"trade:auto"}],[{text:"⬅️ Главное меню",callback_data:"help"}]]}});
  } else if (command === "/trade" || action === "trade" || action?.startsWith("trade:")) {
    const tradeParts = action?.startsWith("trade:") ? action.slice(6).split(":") : ["auto","EURUSD"];
    const atmMode = tradeParts[0] === "atm";
    const aiMode = tradeParts[0] === "ai";
    const timeframe = (atmMode || aiMode) ? "auto" : (tradeParts[0] || "auto");
    const pair = tradeParts[1] || "EURUSD";
    const assetType = webAssetType || "forex";
    const pairLabel = pair === "ALL" ? (assetType === "crypto" ? "вся криптовалюта" : assetType === "stocks" ? "все акции" : "все валютные пары Forex") : pair;
    const label = (atmMode ? "ATM · быстрый снимок M1" : aiMode ? "AI Committee · M1/M3/M5" : timeframe === "auto" ? "все таймфреймы M1/M3/M5" : timeframe + " (" + TIMEFRAMES[timeframe].label + ")") + " • " + pairLabel;
    await send(env, chatId, "🔎 Анализирую текущую картину: " + label + "…");
    try {
      if (await env.SUBSCRIBERS.get("user:stop:" + chatId)) throw new Error("A|MORE STOP включён. Возобнови работу кнопкой RESUME.");
      const result = await openTradingDemo(env, chatId, timeframe, pair, assetType, aiMode ? "ai" : atmMode ? "atm" : "strict");
      if (aiMode) {
        const committee = result.aiCommittee || result.trade?.aiCommittee;
        if (committee) await recordAIUsage(env,chatId,committee,{symbol:result.trade?.symbol||pair,direction:result.trade?.direction||committee.verdict?.direction});
      }
      if (result.none) {
        const diag = (result.diagnostics || []).map(x => "<b>" + html(x.symbol) + " · " + html(x.timeframe) + "</b>: EMA " + html(x.ema) + ", RSI " + x.rsi + ", свеча " + html(x.candle) + ", ADX " + (x.adx ?? "—") + ", подтверждения " + x.score + "/6" + (x.rejection ? " · " + html(x.rejection) : "")).join("\n");
        const errors = result.errors?.length ? "\n\n⚠️ Ошибки данных:\n" + html(result.errors.join("\n")) : "";
        await send(env, chatId, atmMode ? "⚠️ <b>ATM: сейчас не удалось получить пригодные рыночные свечи.</b> Направление не буду выдумывать без котировок.\nПроверены: " + label + "." + errors : "⏸ <b>A|MORE Signals: подтверждённого сигнала пока нет.</b>\nПроверены: " + label + ". Фильтры не ослаблялись. Диагностика:\n\n" + (diag || "Недостаточно данных для анализа.") + errors + "\n\nМожно выбрать другой период или режим «Авто». Сигналы не генерируются искусственно.", {reply_markup:{inline_keyboard:[[{text:"⚡ M1",callback_data:"trade:1m"},{text:"🎯 M3",callback_data:"trade:3m"},{text:"📊 M5",callback_data:"trade:5m"}],[{text:"🤖 Проверить все периоды",callback_data:"trade:auto"}],[{text:"⬅️ Главное меню",callback_data:"help"}]]}});
      } else await send(env, chatId, formatOpenTrade(result.trade), {reply_markup:{inline_keyboard:[[{text:"🔄 Новый анализ",callback_data:"trade_menu"}],[{text:"⬅️ Главное меню",callback_data:"help"}]]}});
    } catch (e) { await send(env, chatId, "⚠️ Не удалось открыть демо-прогноз: " + html(e.message)); }
  } else if (action?.startsWith("arbi_trade:")) {
    const [symbol,buyExchange,sellExchange] = action.slice("arbi_trade:".length).split(":");
    await send(env,chatId,"⏳ Проверяю стаканы и моделирую обе стороны сделки…");
    try {
      if (await env.SUBSCRIBERS.get("user:stop:" + chatId)) throw new Error("A|MORE STOP включён. Возобнови работу кнопкой RESUME.");
      if (!symbol || !buyExchange || !sellExchange || buyExchange===sellExchange) throw new Error("Некорректные параметры демо-сделки.");
      const data = await scan(env);
      const opportunity = data.opportunities.find(x=>x.symbol===symbol&&x.buyExchange===buyExchange&&x.sellExchange===sellExchange);
      if (!opportunity) throw new Error("Возможность исчезла или больше не проходит фильтр. Обнови сканирование.");
      const lockKey = "arbi:paper:lock:"+chatId+":"+symbol+":"+buyExchange+":"+sellExchange;
      if (await env.SUBSCRIBERS.get(lockKey)) throw new Error("Эта демо-возможность уже была исполнена. Повторная кнопка заблокирована на 60 секунд.");
      await env.SUBSCRIBERS.put(lockKey,"1",{expirationTtl:60});
      const result = await executeArbitragePaper(env,chatId,opportunity,100);
      const sign = result.pnl>0?"+":"";
      const label = result.outcome==="win"?"✅ ДЕМО-СДЕЛКА В ПЛЮС":result.outcome==="loss"?"❌ ДЕМО-СДЕЛКА В МИНУС":"➖ БЕЗ РЕЗУЛЬТАТА";
      await send(env,chatId,"💱 <b>A|MORE ARBITRAGE — PAPER EXECUTION</b>\n"+label+"\nПара: <b>"+html(symbol)+"</b>\nКупить: "+html(buyExchange)+" · средняя цена "+price(result.buy.averagePrice)+"\nПродать: "+html(sellExchange)+" · средняя цена "+price(result.sell.averagePrice)+"\nОбъём: "+result.quantity.toFixed(8)+" "+html(symbol.replace("USDT",""))+" (~"+result.quoteBudget.toFixed(2)+" USDT)\nКомиссии: "+result.buyFee.toFixed(3)+"% + "+result.sellFee.toFixed(3)+"%\nИтог после комиссий: <b>"+sign+result.pnl.toFixed(4)+" USDT</b>\nДемо-баланс: <b>"+result.balance.toFixed(2)+" USDT</b>\n\n<i>Симуляция по текущим стаканам и средней цене исполнения. Предполагается заранее размещённый инвентарь на обеих биржах; перевод активов не моделируется. Реальные ордера не отправляются.</i>");
    } catch(e) { await send(env,chatId,"⚠️ Демо-исполнение не состоялось: "+html(e.message)); }
  } else if (command === "/arbi_demo" || action === "arbi_demo") {
    await send(env,chatId,"🔎 Ищу лучшую возможность и проверяю глубину стаканов…");
    try {
      if (await env.SUBSCRIBERS.get("user:stop:" + chatId)) throw new Error("A|MORE STOP включён. Возобнови работу кнопкой RESUME.");
      const data = await scan(env);
      const best = data.opportunities[0];
      if (!best) throw new Error("Нет возможности выше порога net-спреда.");
      const result = await executeArbitragePaper(env,chatId,best,100);
      const sign = result.pnl>0?"+":"";
      await send(env,chatId,"💱 <b>A|MORE ARBITRAGE — PAPER EXECUTION</b>\nПара: <b>"+html(best.symbol)+"</b>\nКупить: "+html(best.buyExchange)+" · "+price(result.buy.averagePrice)+"\nПродать: "+html(best.sellExchange)+" · "+price(result.sell.averagePrice)+"\nИтог после комиссий: <b>"+sign+result.pnl.toFixed(4)+" USDT</b>\nДемо-баланс: <b>"+result.balance.toFixed(2)+" USDT</b>\n<i>Исполнение смоделировано по текущим стаканам; реальные ордера не отправляются.</i>");
    } catch(e) { await send(env,chatId,"⚠️ Демо-сделка не состоялась: "+html(e.message)); }
  } else if (["/start","/help"].includes(command) || action === "help") {
    await send(env, chatId, "⚡ <b>Добро пожаловать в A|MORE ARBITRAGE</b>\nСканер межбиржевых расхождений цен.\n\n" + help(), {reply_markup:keyboard});
  } else if (command === "/scan" || action === "scan") await runScan(env, chatId);
  else if (command === "/subscribe" || action === "subscribe") {
    if (!env.SUBSCRIBERS) await send(env, chatId, "Хранилище подписок пока не подключено. Используй /scan.");
    else { await env.SUBSCRIBERS.put("chat:" + chatId, "1"); await send(env, chatId, "🔔 Уведомления A|MORE Arbitrage включены.", {reply_markup:keyboard}); }
  } else if (command === "/unsubscribe" || action === "unsubscribe") {
    if (env.SUBSCRIBERS) await env.SUBSCRIBERS.delete("chat:" + chatId);
    await send(env, chatId, "🔕 Уведомления A|MORE Arbitrage отключены.", {reply_markup:keyboard});
  } else await send(env, chatId, "Не понял команду. Отправь /help.", {reply_markup:keyboard});
}
async function scheduled(env) {
  if (!env.SUBSCRIBERS) return;
  await settleTradingDemos(env);
  const [list,autoList] = await Promise.all([
    env.SUBSCRIBERS.list({prefix:"chat:",limit:1000}),
    env.SUBSCRIBERS.list({prefix:"auto:paper:state:",limit:1000})
  ]);
  if (!list.keys.length && !autoList.keys.length) return;
  let data = {opportunities:[]};
  try { data = await scan(env); } catch (e) { console.error("Scheduled scan:",e); }
  let triangular = [];
  if (autoList.keys.length) {
    try { triangular = await scanTriangular(env); }
    catch (e) { console.error("Scheduled triangular scan:",e); }
  }
  for (const item of autoList.keys) {
    const chatId = item.name.slice("auto:paper:state:".length);
    const state = await readAutoPaper(env,chatId);
    if (state?.enabled) {
      await runAutoPaperForUser(env,chatId,state,data.opportunities||[],triangular);
    }
  }
  if (!list.keys.length) return;
  for (const x of data.opportunities||[]) {
    const key = "alert:" + x.symbol + ":" + x.buyExchange + ":" + x.sellExchange;
    if (await env.SUBSCRIBERS.get(key)) continue;
    await env.SUBSCRIBERS.put(key,"1",{expirationTtl:300});
    const message = "🚨 <b>A|MORE — новая возможность</b>\n<b>" + html(x.symbol) + "</b>\nКупить: " + price(x.buy) + " • " + html(x.buyExchange) + "\nПродать: " + price(x.sell) + " • " + html(x.sellExchange) + "\nРасчётный net: <b>+" + x.net.toFixed(3) + "%</b>\n<i>Нажми «Сделка» для проверки стаканов и виртуального исполнения обеих сторон.</i>";
    const reply_markup = {inline_keyboard:[[{text:"💱 Сделка · PAPER",callback_data:"arbi_trade:"+x.symbol+":"+x.buyExchange+":"+x.sellExchange}],[{text:"🔄 Обновить сканирование",callback_data:"scan"}]]};
    await Promise.allSettled(list.keys.map(k => send(env,k.name.slice(5),message,{reply_markup})));
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ok:true,service:"A|More Arbitrage",version:"0.3.0-auto-paper"});
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/")) {
      const assetUrl = new URL("/index.html", url.origin);
      return env.ASSETS ? env.ASSETS.fetch(new Request(assetUrl, request)) : new Response("Mini App assets are not configured",{status:503});
    }
    if (url.pathname === "/api/account" && request.method === "GET") {
      try {
        const chatId = await telegramMiniAppUser(request, env);
        // Reconcile expired demo forecasts before showing the account state.
        await settleTradingDemos(env);
        const account = await getDemoAccount(env, chatId);
        const legacyTradeRaw = await env.SUBSCRIBERS.get("paper:trading:" + chatId);
        const activeKeys = await env.SUBSCRIBERS.list({prefix:"paper:trading:" + chatId + ":",limit:1000});
        const activeTrades = [];
        for (const item of activeKeys.keys) {
          const raw = await env.SUBSCRIBERS.get(item.name);
          if (raw) { try { activeTrades.push(JSON.parse(raw)); } catch {} }
        }
        if (legacyTradeRaw) { try { activeTrades.push(JSON.parse(legacyTradeRaw)); } catch {} }
        activeTrades.sort((a,b)=>Number(b.openedAt||b.entryAt||0)-Number(a.openedAt||a.entryAt||0));
        const history = await getDemoHistory(env, chatId);
        const autoPaper = await readAutoPaper(env,chatId);
        const usageDay = new Date().toISOString().slice(0,10);
        const usageKeys = await env.SUBSCRIBERS.list({prefix:"ai:usage:"+chatId+":"+usageDay+":",limit:1000});
        const usageRows = (await Promise.all(usageKeys.keys.map(async key => {
          const raw = await env.SUBSCRIBERS.get(key.name);
          if (!raw) return null;
          try { return JSON.parse(raw); } catch { return null; }
        }))).filter(Boolean).sort((a,b)=>String(b.at).localeCompare(String(a.at)));
        const aiUsage = usageRows.reduce((sum,row)=>({
          requests:sum.requests+1,
          promptTokens:sum.promptTokens+(Number(row.promptTokens)||0),
          completionTokens:sum.completionTokens+(Number(row.completionTokens)||0),
          totalTokens:sum.totalTokens+(Number(row.totalTokens)||0),
          neurons:sum.neurons+(Number(row.neurons)||0)
        }),{requests:0,promptTokens:0,completionTokens:0,totalTokens:0,neurons:0});
        aiUsage.neurons=Number(aiUsage.neurons.toFixed(6));
        aiUsage.remainingNeurons=Math.max(0,10000-aiUsage.neurons);
        aiUsage.rows=usageRows.slice(0,20);
        return Response.json({account,history,activeTrade:activeTrades[0]||null,activeTrades,aiUsage,autoPaper,stopped:!!(await env.SUBSCRIBERS.get("user:stop:" + chatId))},{headers:{"cache-control":"no-store"}});
      } catch(e) { return Response.json({error:e.message},{status:401,headers:{"cache-control":"no-store"}}); }
    }
    if (url.pathname === "/api/signal" && request.method === "POST") {
      try {
        const chatId = await telegramMiniAppUser(request, env);
        if (await env.SUBSCRIBERS.get("user:stop:" + chatId)) {
          return Response.json({error:"A|MORE STOP включён. Возобнови работу кнопкой RESUME."},{status:423,headers:{"cache-control":"no-store"}});
        }
        const body = await request.json();
        const timeframe = body.timeframe || "auto";
        const pair = body.pair || "ALL";
        const result = await openTradingDemo(env, chatId, timeframe, pair, body.assetType || "forex", body.mode === "ai" ? "ai" : body.mode === "atm" ? "atm" : "strict");
        if (body.mode === "ai") {
          const committee = result.aiCommittee || result.trade?.aiCommittee;
          if (committee) await recordAIUsage(env,chatId,committee,{symbol:result.trade?.symbol||pair,direction:result.trade?.direction||committee.verdict?.direction});
        }
        if (result.trade) {
          // Telegram notification is best-effort: a notification failure must not turn
          // a successfully created demo signal into an API error for the Mini App.
          try { await send(env, chatId, formatOpenTrade(result.trade)); }
          catch (notifyError) { console.error("Mini App signal notification failed:", notifyError); }
        }
        return Response.json(result,{headers:{"cache-control":"no-store"}});
      } catch(e) { return Response.json({error:e.message},{status:400,headers:{"cache-control":"no-store"}}); }
    }
    if (url.pathname === "/api/stop" && request.method === "POST") {
      try {
        const chatId = await telegramMiniAppUser(request, env);
        await env.SUBSCRIBERS.put("user:stop:" + chatId, "1");
        await env.SUBSCRIBERS.delete("chat:" + chatId);
        await stopAutoPaper(env,chatId,"global-stop");
        return Response.json({ok:true,stopped:true});
      } catch(e) { return Response.json({error:e.message},{status:401}); }
    }
    if (url.pathname === "/api/reset" && request.method === "POST") {
      try {
        const chatId = await telegramMiniAppUser(request, env);
        await stopAutoPaper(env,chatId,"demo-reset");
        const account = await resetDemoAccount(env, chatId);
        return Response.json({ok:true,account},{headers:{"cache-control":"no-store"}});
      } catch(e) { return Response.json({error:e.message},{status:401}); }
    }
    if (url.pathname === "/api/resume" && request.method === "POST") {
      try {
        const chatId = await telegramMiniAppUser(request, env);
        await env.SUBSCRIBERS.delete("user:stop:" + chatId);
        return Response.json({ok:true,stopped:false});
      } catch(e) { return Response.json({error:e.message},{status:401}); }
    }
    if (url.pathname === "/api/auto-paper/start" && request.method === "POST") {
      try {
        const chatId = await telegramMiniAppUser(request,env);
        if (await env.SUBSCRIBERS.get("user:stop:"+chatId)) return Response.json({error:"Сначала отключи общий STOP."},{status:423});
        const autoPaper = await startAutoPaper(env,chatId);
        return Response.json({ok:true,autoPaper},{headers:{"cache-control":"no-store"}});
      } catch(e) { return Response.json({error:e.message},{status:400,headers:{"cache-control":"no-store"}}); }
    }
    if (url.pathname === "/api/auto-paper/stop" && request.method === "POST") {
      try {
        const chatId = await telegramMiniAppUser(request,env);
        const autoPaper = await stopAutoPaper(env,chatId,"user-request");
        return Response.json({ok:true,autoPaper},{headers:{"cache-control":"no-store"}});
      } catch(e) { return Response.json({error:e.message},{status:401,headers:{"cache-control":"no-store"}}); }
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      try { return Response.json(await dashboard(env), {headers:{"cache-control":"no-store"} }); }
      catch(e) { return Response.json({error:e.message},{status:200,headers:{"cache-control":"no-store"}}); }
    }
    if (request.method === "GET" && url.pathname === "/api/candles") {
      const symbol=url.searchParams.get("symbol") || "BTCUSDT";
      const interval=url.searchParams.get("interval") || "5m";
      const allowedSymbols=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
      const allowedIntervals=["1m","5m","15m","30m","1h","4h"];
      if(!allowedSymbols.includes(symbol)||!allowedIntervals.includes(interval)) return Response.json({error:"Unsupported market or interval"},{status:400});
      try {
        const r=await fetch("https://api.binance.com/api/v3/klines?symbol="+symbol+"&interval="+interval+"&limit=60",{signal:AbortSignal.timeout(9000)});
        if(!r.ok) throw new Error("Binance candles HTTP "+r.status);
        return Response.json(await r.json(),{headers:{"cache-control":"no-store"}});
      } catch(binanceError) {
        try {
          const krakenInterval={"1m":1,"5m":5,"15m":15,"30m":30,"1h":60,"4h":240}[interval];
          const krakenPair=symbol.replace("BTC","XBT");
          const response=await fetch("https://api.kraken.com/0/public/OHLC?pair="+krakenPair+"&interval="+krakenInterval,{signal:AbortSignal.timeout(9000)});
          if(!response.ok) throw new Error("Kraken OHLC HTTP "+response.status);
          const payload=await response.json();
          if(payload.error?.length) throw new Error(payload.error.join(", "));
          const rows=Object.entries(payload.result||{}).find(([key])=>key!=="last")?.[1]||[];
          if(!rows.length) throw new Error("Kraken не вернул свечи для "+symbol);
          const candles=rows.map(x=>{const start=Number(x[0])*1000;return [start,x[1],x[2],x[3],x[4],x[6],start+krakenInterval*60000-1]});
          return Response.json(candles,{headers:{"cache-control":"no-store","x-market-source":"Kraken"}});
        } catch(krakenError) {
          try {
            const bar={"1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H"}[interval];
            const instrument=symbol.replace("USDT","-USDT");
            const response=await fetch("https://www.okx.com/api/v5/market/candles?instId="+instrument+"&bar="+bar+"&limit=60",{signal:AbortSignal.timeout(9000)});
            if(!response.ok)throw new Error("OKX candles HTTP "+response.status);
            const payload=await response.json();
            if(payload.code!=="0"||!Array.isArray(payload.data))throw new Error(payload.msg||"OKX candles response error");
            const candles=payload.data.slice().reverse().map(x=>[Number(x[0]),x[1],x[2],x[3],x[4],x[5],Number(x[0])+({"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000}[interval])-1]);
            if(candles.length<30)throw new Error("OKX вернул недостаточно свечей");
            return Response.json(candles,{headers:{"cache-control":"no-store","x-market-source":"OKX"}});
          } catch(okxError) {
            const duration={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000}[interval];
            const gateInterval={"1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h"}[interval];
            try {
              const pair=symbol.replace("USDT","_USDT");
              const response=await fetch("https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair="+pair+"&interval="+gateInterval+"&limit=60",{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
              if(!response.ok)throw new Error("Gate.io candles HTTP "+response.status);
              const rows=await response.json();
              if(!Array.isArray(rows))throw new Error("Gate.io: некорректный ответ");
              const candles=rows.slice().sort((a,b)=>Number(a[0])-Number(b[0])).map(x=>[Number(x[0])*1000,x[5],x[3],x[4],x[2],x[6],Number(x[0])*1000+duration-1]);
              if(candles.length<30)throw new Error("Gate.io: недостаточно свечей");
              return Response.json(candles,{headers:{"cache-control":"no-store","x-market-source":"Gate.io"}});
            } catch(gateError) {
              try {
                const type={"1m":"1min","5m":"5min","15m":"15min","30m":"30min","1h":"1hour","4h":"4hour"}[interval];
                const pair=symbol.replace("USDT","-USDT");
                const response=await fetch("https://api.kucoin.com/api/v1/market/candles?symbol="+pair+"&type="+type,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
                if(!response.ok)throw new Error("KuCoin candles HTTP "+response.status);
                const payload=await response.json();
                if(payload.code!=="200000"||!Array.isArray(payload.data))throw new Error("KuCoin: некорректный ответ");
                const candles=payload.data.slice().reverse().map(x=>[Number(x[0])*1000,x[1],x[3],x[4],x[2],x[5],Number(x[0])*1000+duration-1]);
                if(candles.length<30)throw new Error("KuCoin: недостаточно свечей");
                return Response.json(candles,{headers:{"cache-control":"no-store","x-market-source":"KuCoin"}});
              } catch(kucoinError) {
                return Response.json({error:"Binance: "+binanceError.message+"; Kraken: "+krakenError.message+"; OKX: "+okxError.message+"; Gate.io: "+gateError.message+"; KuCoin: "+kucoinError.message},{status:502});
              }
            }
          }
        }
      }
    }
    // Register Telegram's webhook without exposing bot credentials.
    if (request.method === "GET" && env.WEBHOOK_PATH_SECRET && url.pathname === "/setup/" + env.WEBHOOK_PATH_SECRET) {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ok:false,error:"Missing Telegram secrets"}, {status:500});
      }
      const webhookUrl = url.origin + "/telegram/" + env.WEBHOOK_PATH_SECRET;
      const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/setWebhook", {
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          url:webhookUrl,
          secret_token:env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates:["message","callback_query"],
          drop_pending_updates:false
        })
      });
      const result = await response.json();
      const ok = response.ok && result.ok === true;
      return Response.json({ok,telegram:result.description || (ok ? "Webhook registered" : "Registration failed")}, {status:ok ? 200 : 502});
    }
    if (request.method !== "POST" || !env.WEBHOOK_PATH_SECRET || url.pathname !== "/telegram/" + env.WEBHOOK_PATH_SECRET) return new Response("Not found",{status:404});
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized",{status:401});
    let update;
    try { update = await request.json(); } catch { return new Response("Bad Request",{status:400}); }
    try { await handle(update,env); } catch (e) { console.error("Telegram update:",e); }
    return new Response("ok");
  },
  async scheduled(_event,env,ctx) { ctx.waitUntil(scheduled(env)); }
};
