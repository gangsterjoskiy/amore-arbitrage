import { getDemoAccount, applyDemoResult } from "./demo.js";

const TRADE_STAKE = 10;
const PAYOUT = 0.8;
// Regular Forex instruments currently listed in Pocket Option's general asset schedule.
export const FOREX_PAIRS = ["EURUSD","AUDCAD","AUDCHF","AUDJPY","AUDUSD","CADCHF","CADJPY","CHFJPY","EURAUD","EURCAD","EURCHF","EURGBP","EURJPY","GBPAUD","GBPCAD","GBPCHF","GBPJPY","GBPUSD","USDCAD","USDCHF","USDJPY"];
const CRYPTO_PAIRS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
const PAIRS = [...FOREX_PAIRS,...CRYPTO_PAIRS];
// Ordinary shares listed in Pocket Option's published asset schedule. OTC instruments are deliberately excluded.
export const STOCKS = ["AAPL","TSLA","MSFT","AMZN","NFLX","META","INTC","AMD","CSCO","BA","V","AXP","JNJ","PFE","JPM","C","MCD","XOM","BABA","FDX","GME","COIN","PLTR","MARA"];
function mskTime(timestamp) { return new Intl.DateTimeFormat("ru-RU", {timeZone:"Europe/Moscow",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(timestamp)); }
export const TIMEFRAMES = {
  "1m": { label: "1 минута", expiryMs: 60000, rank: 1 },
  "3m": { label: "3 минуты", expiryMs: 180000, rank: 2 },
  "5m": { label: "5 минут", expiryMs: 300000, rank: 3 }
};
function aggregateCandles(rows,minutes){
  const size=minutes*60000,buckets=new Map();
  for(const row of rows){const start=Math.floor((row.closeTime+1-size)/size)*size;let b=buckets.get(start);if(!b){b={open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume||0,closeTime:start+size-1,count:0};buckets.set(start,b);}else{b.high=Math.max(b.high,row.high);b.low=Math.min(b.low,row.low);b.close=row.close;b.volume+=row.volume||0;}b.count++;}
  return [...buckets.values()].filter(b=>b.count===minutes).sort((a,b)=>a.closeTime-b.closeTime);
}
async function candles(symbol, interval) {
  if (FOREX_PAIRS.includes(symbol)) {
    const ticker=symbol+"=X";
    const bar={"1m":"1m","3m":"1m","5m":"5m"}[interval];
    if(!bar)throw new Error("Для Forex доступны экспирации 1, 3 и 5 минут.");
    const response=await fetch("https://query1.finance.yahoo.com/v8/finance/chart/"+ticker+"?range=5d&interval="+bar,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new Error("Yahoo Finance Forex HTTP "+response.status);
    const payload=await response.json(),result=payload.chart?.result?.[0];
    if(payload.chart?.error||!result)throw new Error(payload.chart?.error?.description||"Yahoo Finance: нет Forex-котировок для "+symbol);
    const q=result.indicators?.quote?.[0],times=result.timestamp||[];
    const duration={"1m":60000,"3m":60000,"5m":300000}[interval];
    const rows=times.map((t,i)=>({open:Number(q?.open?.[i]),high:Number(q?.high?.[i]),low:Number(q?.low?.[i]),close:Number(q?.close?.[i]),volume:0,closeTime:t*1000+duration-1}))
      .filter(x=>[x.open,x.high,x.low,x.close,x.closeTime].every(Number.isFinite)&&x.open>0&&x.high>0&&x.low>0&&x.close>0);
    if(rows.length<30)throw new Error("Yahoo Finance: недостаточно Forex-свечей для "+symbol);
    return interval==="3m"?aggregateCandles(rows,3):rows;
  }
  if (STOCKS.includes(symbol)) {
    const bar={"1m":"1m","3m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"60m","4h":"60m"}[interval];
    const response=await fetch("https://query1.finance.yahoo.com/v8/finance/chart/"+symbol+"?range=5d&interval="+bar,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new Error("Yahoo Finance HTTP "+response.status);
    const payload=await response.json(),result=payload.chart?.result?.[0];
    if(payload.chart?.error||!result)throw new Error(payload.chart?.error?.description||"Yahoo Finance: нет данных для "+symbol);
    if(result.meta?.marketState&&result.meta.marketState!=="REGULAR")throw new Error("Биржа акций закрыта или торгуется вне основной сессии. Обычные акции временно недоступны.");
    const q=result.indicators?.quote?.[0],times=result.timestamp||[];
    const rows=times.map((t,i)=>({open:Number(q?.open?.[i]),high:Number(q?.high?.[i]),low:Number(q?.low?.[i]),close:Number(q?.close?.[i]),volume:Number(q?.volume?.[i]||0),closeTime:t*1000+({"1m":60000,"3m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000}[interval])-1}))
      .filter(x=>[x.open,x.high,x.low,x.close,x.closeTime].every(Number.isFinite)&&x.open>0&&x.high>0&&x.low>0&&x.close>0);
    if(rows.length<30)throw new Error("Yahoo Finance: недостаточно свечей для "+symbol);
    return interval==="3m"?aggregateCandles(rows,3):rows;
  }
  const failures=[];
  const normalize=(rows,mapper)=>rows.map(mapper).filter(x=>[x.open,x.high,x.low,x.close,x.closeTime].every(Number.isFinite)&&x.open>0&&x.high>0&&x.low>0&&x.close>0);
  try {
    const response=await fetch("https://api.binance.com/api/v3/klines?symbol="+symbol+"&interval="+interval+"&limit=60",{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const rows=await response.json();
    if(!Array.isArray(rows)||rows.length<30)throw new Error("недостаточно свечей");
    return normalize(rows,x=>({open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]),closeTime:Number(x[6])}));
  } catch(e) { failures.push("Binance: "+e.message); }
  const minutes={"1m":1,"3m":1,"5m":5,"15m":15,"30m":30}[interval];
  if(minutes)try {
    const pair=symbol.replace("BTC","XBT");
    const response=await fetch("https://api.kraken.com/0/public/OHLC?pair="+pair+"&interval="+minutes,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const payload=await response.json();
    if(payload.error?.length)throw new Error(payload.error.join(", "));
    const rows=Object.entries(payload.result||{}).find(([key])=>key!=="last")?.[1]||[];
    const candles=normalize(rows,x=>({open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[6]),closeTime:Number(x[0])*1000+minutes*60000-1}));
    if(candles.length>=30)return interval==="3m"?aggregateCandles(candles,3):candles;
    throw new Error("недостаточно свечей");
  } catch(e) { failures.push("Kraken: "+e.message); }
  const okxBar={"1m":"1m","5m":"5m","15m":"15m","30m":"30m"}[interval];
  if(okxBar)try {
    const instrument=symbol.replace("USDT","-USDT");
    const response=await fetch("https://www.okx.com/api/v5/market/candles?instId="+instrument+"&bar="+okxBar+"&limit=60",{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const payload=await response.json();
    if(payload.code!=="0"||!Array.isArray(payload.data))throw new Error(payload.msg||"ответ без данных");
    const rows=payload.data.slice().reverse();
    const duration={"1m":60000,"5m":300000,"15m":900000,"30m":1800000}[interval];
    const candles=normalize(rows,x=>({open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]),closeTime:Number(x[0])+duration-1}));
    if(candles.length>=30)return candles;
    throw new Error("недостаточно свечей");
  } catch(e) { failures.push("OKX: "+e.message); }
  const durationMs={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000}[interval];
  const gateInterval={"1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h"}[interval];
  if(gateInterval)try {
    const pair=symbol.replace("USDT","_USDT");
    const response=await fetch("https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair="+pair+"&interval="+gateInterval+"&limit=60",{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const rows=await response.json();
    if(!Array.isArray(rows))throw new Error("некорректный ответ");
    const candles=normalize(rows.slice().reverse(),x=>({open:Number(x[5]),high:Number(x[3]),low:Number(x[4]),close:Number(x[2]),volume:Number(x[6]),closeTime:Number(x[0])*1000+durationMs-1}));
    if(candles.length>=30)return candles;
    throw new Error("недостаточно свечей");
  } catch(e) { failures.push("Gate.io: "+e.message); }
  const kucoinType={"1m":"1min","5m":"5min","15m":"15min","30m":"30min","1h":"1hour","4h":"4hour"}[interval];
  if(kucoinType)try {
    const pair=symbol.replace("USDT","-USDT");
    const response=await fetch("https://api.kucoin.com/api/v1/market/candles?symbol="+pair+"&type="+kucoinType,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const payload=await response.json();
    if(payload.code!=="200000"||!Array.isArray(payload.data))throw new Error("ответ без данных");
    const candles=normalize(payload.data.slice().reverse(),x=>({open:Number(x[1]),close:Number(x[2]),high:Number(x[3]),low:Number(x[4]),volume:Number(x[5]),closeTime:Number(x[0])*1000+durationMs-1}));
    if(candles.length>=30)return candles;
    throw new Error("недостаточно свечей");
  } catch(e) { failures.push("KuCoin: "+e.message); }
  throw new Error(failures.join("; ")||"нет доступных источников свечей");
}
async function currentPrice(symbol) {
  if (FOREX_PAIRS.includes(symbol)) {
    const response=await fetch("https://query1.finance.yahoo.com/v8/finance/chart/"+symbol+"=X?range=1d&interval=1m",{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error("Yahoo Finance Forex HTTP "+response.status);
    const payload=await response.json(),result=payload.chart?.result?.[0];
    const price=Number(result?.meta?.regularMarketPrice);
    if(payload.chart?.error||!Number.isFinite(price)||price<=0)throw new Error(payload.chart?.error?.description||"Yahoo Finance: нет текущей Forex-цены для "+symbol);
    return price;
  }
  if (STOCKS.includes(symbol)) {
    const response=await fetch("https://query1.finance.yahoo.com/v8/finance/chart/"+symbol+"?range=1d&interval=1m",{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error("Yahoo Finance HTTP "+response.status);
    const payload=await response.json(),result=payload.chart?.result?.[0];
    const price=Number(result?.meta?.regularMarketPrice);
    if(payload.chart?.error||!Number.isFinite(price)||price<=0)throw new Error(payload.chart?.error?.description||"Yahoo Finance: нет текущей цены для "+symbol);
    return price;
  }
  const failures=[];
  try {
    const response=await fetch("https://api.binance.com/api/v3/ticker/price?symbol="+symbol,{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const data=await response.json(),price=Number(data.price);
    if(Number.isFinite(price)&&price>0)return price;
    throw new Error("нет цены");
  } catch(e) { failures.push("Binance: "+e.message); }
  const pair=symbol.replace("BTC","XBT");
  try {
    const response=await fetch("https://api.kraken.com/0/public/Ticker?pair="+pair,{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const data=await response.json();
    if(data.error?.length)throw new Error(data.error.join(", "));
    const row=Object.entries(data.result||{}).find(([key])=>key!=="last")?.[1];
    const price=Number(row?.c?.[0]);
    if(Number.isFinite(price)&&price>0)return price;
    throw new Error("нет цены");
  } catch(e) { failures.push("Kraken: "+e.message); }
  try {
    const instrument=symbol.replace("USDT","-USDT");
    const response=await fetch("https://www.okx.com/api/v5/market/ticker?instId="+instrument,{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const data=await response.json(),price=Number(data.data?.[0]?.last);
    if(data.code==="0"&&Number.isFinite(price)&&price>0)return price;
    throw new Error(data.msg||"нет цены");
  } catch(e) { failures.push("OKX: "+e.message); }
  try {
    const instrument=symbol.replace("USDT","_USDT");
    const response=await fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair="+instrument,{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const data=await response.json(),price=Number(data[0]?.last);
    if(Number.isFinite(price)&&price>0)return price;
    throw new Error("нет цены");
  } catch(e) { failures.push("Gate.io: "+e.message); }
  try {
    const instrument=symbol.replace("USDT","-USDT");
    const response=await fetch("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol="+instrument,{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw new Error("HTTP "+response.status);
    const data=await response.json(),bid=Number(data.data?.bestBid),ask=Number(data.data?.bestAsk);
    if(data.code==="200000"&&bid>0&&ask>=bid)return (bid+ask)/2;
    throw new Error("нет цены");
  } catch(e) { failures.push("KuCoin: "+e.message); }
  throw new Error(failures.join("; "));
}
function ema(values, period) {
  const k=2/(period+1); let result=values[0];
  for(let i=1;i<values.length;i++) result=values[i]*k+result*(1-k);
  return result;
}
function rsi(values, period=14) {
  let gains=0,losses=0;
  for(let i=values.length-period-1;i<values.length-1;i++){const d=values[i+1]-values[i];if(d>0)gains+=d;else losses-=d;}
  if(losses===0)return 100;
  const rs=(gains/period)/(losses/period);return 100-100/(1+rs);
}
function candleShape(c) {
  const body=Math.abs(c.close-c.open),range=Math.max(0,c.high-c.low);
  return {body,range,upper:c.high-Math.max(c.open,c.close),lower:Math.min(c.open,c.close)-c.low,bull:c.close>c.open,bear:c.close<c.open};
}
function detectCandlestickPatterns(rows) {
  const found={bull:[],bear:[],neutral:[]};
  if(rows.length<3)return found;
  const a=rows[rows.length-3],b=rows[rows.length-2],c=rows[rows.length-1];
  const sa=candleShape(a),sb=candleShape(b),sc=candleShape(c);
  const midpoint=(a.open+a.close)/2,bodyTop=Math.max(a.open,a.close),bodyBottom=Math.min(a.open,a.close);
  if(sb.bear&&sc.bull&&c.open<=b.close&&c.close>=b.open)found.bull.push("бычье поглощение");
  if(sb.bull&&sc.bear&&c.open>=b.close&&c.close<=b.open)found.bear.push("медвежье поглощение");
  if(sc.range>0&&sc.lower>=sc.body*2&&sc.upper<=Math.max(sc.body*.7,sc.range*.05)&&c.close>=c.open)found.bull.push("молот");
  if(sc.range>0&&sc.upper>=sc.body*2&&sc.lower<=Math.max(sc.body*.7,sc.range*.05)&&c.close<=c.open)found.bear.push("падающая звезда");
  if(sa.bear&&sb.body<sa.body*.55&&sc.bull&&c.close>midpoint)found.bull.push("утренняя звезда");
  if(sa.bull&&sb.body<sa.body*.55&&sc.bear&&c.close<midpoint)found.bear.push("вечерняя звезда");
  if(sb.bear&&sc.bull&&c.open<b.low&&c.close>=(b.open+b.close)/2&&c.close<b.open)found.bull.push("просвет в облаках");
  if(sb.bull&&sc.bear&&c.open>b.high&&c.close<=(b.open+b.close)/2&&c.close>b.open)found.bear.push("завеса из тёмных облаков");
  if(sb.bear&&sc.bull&&c.open>bodyBottom&&c.close<bodyTop)found.bull.push("бычье харами");
  if(sb.bull&&sc.bear&&c.open<bodyTop&&c.close>bodyBottom)found.bear.push("медвежье харами");
  if(sc.range>0&&sc.body/sc.range<=.1)found.neutral.push("доджи");
  if(c.high<b.high&&c.low>b.low)found.neutral.push("внутренний бар");
  return found;
}
function mean(values){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}
function standardDeviation(values){const m=mean(values);return Math.sqrt(mean(values.map(x=>(x-m)**2)));}
function macdHistogram(values){
  const line=[];
  for(let i=0;i<values.length;i++)line.push(ema(values.slice(0,i+1),12)-ema(values.slice(0,i+1),26));
  const signal=ema(line.slice(-9),9);
  return {histogram:line[line.length-1]-signal,previous:line[line.length-2]-ema(line.slice(-10,-1),9)};
}
function directionalStrength(rows,period=14){
  const tr=[],plus=[],minus=[];
  for(let i=1;i<rows.length;i++){
    const p=rows[i-1],c=rows[i];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
    const up=c.high-p.high,down=p.low-c.low;
    plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);
  }
  const dx=[];
  for(let i=period-1;i<tr.length;i++){
    const t=mean(tr.slice(i-period+1,i+1)),p=mean(plus.slice(i-period+1,i+1)),m=mean(minus.slice(i-period+1,i+1));
    const pdi=t?p/t*100:0,mdi=t?m/t*100:0;
    dx.push({value:pdi+mdi?Math.abs(pdi-mdi)/(pdi+mdi)*100:0,pdi,mdi});
  }
  const latest=dx[dx.length-1]||{value:0,pdi:0,mdi:0};
  return {adx:mean(dx.slice(-period).map(x=>x.value)),pdi:latest.pdi,mdi:latest.mdi};
}
function averageTrueRange(rows,period=14){
  const ranges=[];
  for(let i=1;i<rows.length;i++){const p=rows[i-1],c=rows[i];ranges.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
  return mean(ranges.slice(-period));
}
function analyze(rows) {
  const closes=rows.map(x=>x.close),last=rows[rows.length-1],prev=rows[rows.length-2];
  const fast=ema(closes.slice(-35),9),slow=ema(closes.slice(-50),21);
  const fastPrior=ema(closes.slice(-38,-3),9),momentum=rsi(closes,14);
  const atr=averageTrueRange(rows,14),strength=directionalStrength(rows,14),macd=macdHistogram(closes);
  const recent=rows.slice(-5),prior=rows.slice(-10,-5);
  const higherHigh=mean(recent.map(x=>x.high))>mean(prior.map(x=>x.high));
  const higherLow=mean(recent.map(x=>x.low))>mean(prior.map(x=>x.low));
  const lowerHigh=mean(recent.map(x=>x.high))<mean(prior.map(x=>x.high));
  const lowerLow=mean(recent.map(x=>x.low))<mean(prior.map(x=>x.low));
  const shape=candleShape(last),closePosition=shape.range?(last.close-last.low)/shape.range:.5;
  const bullishCandle=shape.bull&&shape.body/Math.max(shape.range,1e-12)>=.45&&closePosition>=.68;
  const bearishCandle=shape.bear&&shape.body/Math.max(shape.range,1e-12)>=.45&&closePosition<=.32;
  const trendUp=fast>slow&&fast>fastPrior,trendDown=fast<slow&&fast<fastPrior;
  const momentumUp=momentum>=51&&momentum<=67,momentumDown=momentum<=49&&momentum>=33;
  const macdUp=macd.histogram>0&&macd.histogram>=macd.previous,macdDown=macd.histogram<0&&macd.histogram<=macd.previous;
  const strengthUp=strength.adx>=18&&strength.pdi>strength.mdi,strengthDown=strength.adx>=18&&strength.mdi>strength.pdi;
  const structureUp=higherHigh&&higherLow,structureDown=lowerHigh&&lowerLow;
  const up=[trendUp,momentumUp,macdUp,strengthUp,bullishCandle,structureUp].filter(Boolean).length;
  const down=[trendDown,momentumDown,macdDown,strengthDown,bearishCandle,structureDown].filter(Boolean).length;
  const patterns=detectCandlestickPatterns(rows);
  const support=Math.min(...rows.slice(-20).map(x=>x.low));
  const resistance=Math.max(...rows.slice(-20).map(x=>x.high));
  const nearResistance=atr>0&&resistance-last.close<atr*.25&&last.close<resistance;
  const nearSupport=atr>0&&last.close-support<atr*.25&&last.close>support;
  const volatilitySpike=atr>0&&shape.range>atr*2.5;
  let direction=up>down?"UP":down>up?"DOWN":null,score=Math.max(up,down);
  let rejection="";
  if(strength.adx<18)rejection="слабый тренд / боковой рынок (ADX ниже 18)";
  else if(direction&&Math.abs(up-down)<2)rejection="противоречивые факторы: нет перевеса минимум в 2 подтверждения";
  else if(volatilitySpike)rejection="аномально большая последняя свеча — риск разворота";
  else if(direction==="UP"&&nearResistance)rejection="цена слишком близко к сопротивлению";
  else if(direction==="DOWN"&&nearSupport)rejection="цена слишком близко к поддержке";
  else if(direction==="UP"&&!(trendUp&&macdUp&&strengthUp&&bullishCandle))rejection="нет обязательного подтверждения для ВВЕРХ";
  else if(direction==="DOWN"&&!(trendDown&&macdDown&&strengthDown&&bearishCandle))rejection="нет обязательного подтверждения для ВНИЗ";
  else if(score<5)rejection="недостаточно независимых подтверждений (нужно минимум 5 из 6)";
  if(rejection)direction=null;
  const trend=fast>slow?"восходящий":fast<slow?"нисходящий":"боковой";
  const activePatterns=up>down?patterns.bull:down>up?patterns.bear:[];
  const patternText=activePatterns.length?activePatterns.join(", "):patterns.neutral.length?patterns.neutral.join(", "):"чёткого паттерна нет";
  const analysis={trend,rsi:Number(momentum.toFixed(1)),pattern:patternText,support,resistance,adx:Number(strength.adx.toFixed(1)),atr,
    macd:macd.histogram>0?"положительная":"отрицательная",
    structure:structureUp?"повышающиеся максимумы и минимумы":structureDown?"понижающиеся максимумы и минимумы":"не подтверждена",
    candle:bullishCandle?"сильная бычья":bearishCandle?"сильная медвежья":"слабая / нейтральная",
    explanation:direction==="UP"?"EMA-тренд, MACD, ADX/DI, RSI, импульс свечи и структура рынка подтверждают рост":
      direction==="DOWN"?"EMA-тренд, MACD, ADX/DI, RSI, импульс свечи и структура рынка подтверждают снижение":
      "Сигнал отфильтрован: "+(rejection||"направление не подтверждено")};
  return {direction,score,reasons:direction?[analysis.explanation]:[],entry:last.close,candleCloseTime:last.closeTime,atr,analysis,
    diagnostics:{ema:trend,rsi:analysis.rsi,candle:analysis.candle,patterns,adx:analysis.adx,score,direction:direction||"нет",rejection:rejection||"нет единого направления"}};
}
export async function openTradingDemo(env,chatId,requestedTimeframe="auto",requestedPair="ALL",requestedAssetType="forex") {
  if(!env.SUBSCRIBERS)throw new Error("KV namespace SUBSCRIBERS is not configured");
  if(await env.SUBSCRIBERS.get("user:stop:"+chatId))throw new Error("A|MORE STOP включён. Возобнови работу кнопкой в Telegram-боте.");
  // Каждый запрос создаёт отдельный прогноз. Уже открытые прогнозы не блокируют новые.
  const account=await getDemoAccount(env,chatId);
  if(account.trading.balance<TRADE_STAKE)throw new Error("На демо-балансе A|MORE Signals недостаточно средств.");
  const intervals=requestedTimeframe==="auto"?Object.keys(TIMEFRAMES):[requestedTimeframe];
  if(!TIMEFRAMES[requestedTimeframe]&&requestedTimeframe!=="auto")throw new Error("Неизвестный таймфрейм.");
  if(requestedPair!=="ALL"&&!PAIRS.includes(requestedPair)&&!STOCKS.includes(requestedPair))throw new Error("Неизвестный актив.");
  const selectedPairs=requestedPair==="ALL"?(requestedAssetType==="crypto"?CRYPTO_PAIRS:requestedAssetType==="stocks"?STOCKS:FOREX_PAIRS):[requestedPair];
  const tasks=[];for(const interval of intervals)for(const symbol of selectedPairs)tasks.push({interval,symbol});
  const forexBaseCache=new Map();
  const results=await Promise.all(tasks.map(async task=>{try{
    let rows;
    if(FOREX_PAIRS.includes(task.symbol)){
      if(!forexBaseCache.has(task.symbol))forexBaseCache.set(task.symbol,candles(task.symbol,"1m"));
      const base=await forexBaseCache.get(task.symbol);
      rows=task.interval==="1m"?base:aggregateCandles(base,Number(task.interval.slice(0,-1)));
      if(rows.length<30)throw new Error("недостаточно закрытых Forex-свечей");
    }else rows=await candles(task.symbol,task.interval);
    rows=rows.filter(c=>c.closeTime<Date.now()-1000);
    if(rows.length<30)throw new Error("недостаточно закрытых свечей после фильтрации незавершённой свечи");
    const signal=analyze(rows);
    if(signal.candleCloseTime){
      const intervalMs=TIMEFRAMES[task.interval].expiryMs;
      const age=Date.now()-signal.candleCloseTime;
      if(age>intervalMs+90000)throw new Error("устаревшие свечи: последняя закрытая свеча старше допустимого интервала");
      if(age< -30000)throw new Error("время свечи из будущего — источник данных отклонён");
    }
    return {...task,signal};
  }catch(e){return {...task,error:task.symbol+" "+task.interval+": "+e.message};}}));
  let candidates=results.filter(x=>x.signal?.direction).map(x=>({symbol:x.symbol,timeframe:x.interval,...x.signal}));
  if(requestedTimeframe==="auto"){
    candidates=candidates.map(candidate=>({...candidate,agreement:candidates.filter(other=>other.symbol===candidate.symbol&&other.direction===candidate.direction).length})).filter(candidate=>candidate.agreement>=2);
  }else candidates=candidates.map(candidate=>({...candidate,agreement:1}));
  candidates.sort((a,b)=>b.score-a.score||b.agreement-a.agreement||TIMEFRAMES[b.timeframe].rank-TIMEFRAMES[a.timeframe].rank);
  const diagnostics=results.filter(x=>x.signal).map(x=>({symbol:x.symbol,timeframe:x.interval,...x.signal.diagnostics}));
  const errors=results.filter(x=>x.error).map(x=>x.error),best=candidates[0];
  if(!best)return {none:true,errors,diagnostics,requestedTimeframe};
  const entry=await currentPrice(best.symbol);
  const now=Date.now(),duration=TIMEFRAMES[best.timeframe].expiryMs;
  const id=String(chatId)+":"+now+":"+crypto.randomUUID();
  const trade={id,symbol:best.symbol,timeframe:best.timeframe,direction:best.direction,entry,stake:TRADE_STAKE,payout:PAYOUT,openedAt:now,entryAt:now,entryTimeMsk:mskTime(now),settleAt:now+duration,expiryMs:duration,reasons:best.reasons,score:best.score,timeframeAgreement:best.agreement,analysis:best.analysis,signalCandleCloseTime:best.candleCloseTime,assetType:STOCKS.includes(best.symbol)?"stock":FOREX_PAIRS.includes(best.symbol)?"forex":"crypto",marketSource:STOCKS.includes(best.symbol)?"Yahoo Finance · обычный биржевой рынок":FOREX_PAIRS.includes(best.symbol)?"Yahoo Finance · Forex spot (не поток Pocket Option)":"агрегированные спотовые котировки"};
  const tradeKey="paper:trading:"+chatId+":"+now+":"+crypto.randomUUID();
  await env.SUBSCRIBERS.put(tradeKey,JSON.stringify(trade),{expirationTtl:Math.ceil(duration/1000)+300});
  return {trade};
}
export async function settleTradingDemos(env) {
  if(!env.SUBSCRIBERS)return;
  const list=await env.SUBSCRIBERS.list({prefix:"paper:trading:",limit:1000});
  for(const item of list.keys){
    const raw=await env.SUBSCRIBERS.get(item.name);if(!raw)continue;
    let trade;try{trade=JSON.parse(raw);}catch{await env.SUBSCRIBERS.delete(item.name);continue;}
    if(Date.now()<trade.settleAt)continue;
    try{
      // Use the first fully closed 1-minute candle at/after expiry, not the delayed cron-time quote.
      const settlementRows=(await candles(trade.symbol,"1m"))
        .filter(c=>c.closeTime<Date.now()-1000&&c.closeTime>=trade.settleAt-1000&&c.closeTime<=trade.settleAt+90000)
        .sort((a,b)=>a.closeTime-b.closeTime);
      const settlement=settlementRows[0];
      if(!settlement)continue;
      const exit=settlement.close;
      if(!Number.isFinite(exit)||exit<=0)continue;
      const outcome=exit===trade.entry?"draw":(trade.direction==="UP"?exit>trade.entry:exit<trade.entry)?"win":"loss";
      const pnl=outcome==="win"?trade.stake*trade.payout:outcome==="loss"?-trade.stake:0;
      const chatId=item.name.slice("paper:trading:".length).split(":")[0];
      await applyDemoResult(env,chatId,"trading",pnl,outcome,{type:"signal",signalId:trade.id,symbol:trade.symbol,timeframe:trade.timeframe,direction:trade.direction,entry:trade.entry,exit,stake:trade.stake,score:trade.score,entryAt:trade.entryAt,entryTimeMsk:trade.entryTimeMsk,settlementCandleCloseTime:settlement.closeTime,settlementDelayMs:settlement.closeTime-trade.settleAt});
      await env.SUBSCRIBERS.delete(item.name);
      const label=outcome==="win"?"✅ ПРОГНОЗ СБЫЛСЯ":outcome==="loss"?"❌ ПРОГНОЗ НЕ СБЫЛСЯ":"➖ НИЧЬЯ";
      const text="⏱ <b>A|MORE Signals — результат демо-прогноза</b>\n"+label+"\nПара: <b>"+trade.symbol+"</b>\nТаймфрейм: <b>"+(trade.timeframe||"1m")+"</b>\nПрогноз: <b>"+trade.direction+"</b>\nВход: "+trade.entry+"\nЦена расчёта (ближайшая закрытая M1-свеча): "+exit+"\nP/L: <b>"+(pnl>0?"+":"")+pnl.toFixed(2)+" USDT</b>\n<i>Демо-модель. Это не исполнение у брокера.</i>";
      if(env.TELEGRAM_BOT_TOKEN)await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📊 A|MORE Arbitrage",callback_data:"scan"},{text:"📈 A|MORE Signals",callback_data:"trade_menu"}],[{text:"💼 Демо-балансы",callback_data:"demo"},{text:"🧾 Статистика",callback_data:"stats"}]]}})});
    }catch(e){console.error("Paper trade settlement:",item.name,e);}
  }
}
export function formatOpenTrade(trade) {
  const tf=trade.timeframe||"1m";
  const a=trade.analysis||{};
  const assetLabel=trade.assetType==="stock"?"Акция":trade.assetType==="forex"?"Валютная пара":"Криптовалюта";
  const symbolLabel=trade.symbol.endsWith("USDT")?trade.symbol.replace("USDT","/USDT"):trade.symbol.length===6?trade.symbol.slice(0,3)+"/"+trade.symbol.slice(3):trade.symbol;
  return "📊 <b>A|MORE SIGNALS — ДЕМО-ПРОГНОЗ</b>\n\n<b>"+assetLabel+":</b> "+symbolLabel+"\n"+(trade.direction==="UP"?"🟢 <b>СТАВКА: ВВЕРХ ↑</b>":"🔴 <b>СТАВКА: ВНИЗ ↓</b>")+"\n\n<b>Время входа: "+(trade.entryTimeMsk||mskTime(trade.entryAt||trade.openedAt))+" МСК</b>\n<b>Таймфрейм:</b> "+tf+" · экспирация "+TIMEFRAMES[tf].label+"\n<b>Цена на момент сигнала:</b> "+trade.entry+"\n<b>Ожидаемое окончание:</b> "+mskTime(trade.settleAt)+" МСК\n\n<b>ПОЧЕМУ ЭТО НАПРАВЛЕНИЕ</b>\n"+(a.explanation||trade.reasons.join("; "))+"\n\n<b>Техническая картина</b>\n• Тренд: "+(a.trend||"—")+"\n• Свечной паттерн: "+(a.pattern||"—")+"\n• RSI (14): "+(a.rsi??"—")+"\n• Поддержка: "+(a.support??"—")+"\n• Сопротивление: "+(a.resistance??"—")+"\n• ADX (сила тренда): "+(a.adx??"—")+"\n• MACD: "+(a.macd??"—")+"\n• Структура: "+(a.structure??"—")+"\n• Подтверждения модели: "+trade.score+"/6\n• Согласование таймфреймов: "+(trade.timeframeAgreement||1)+(trade.timeframeAgreement>1?"/3":"/1")+"\n\n<i>Источник: "+(trade.marketSource||"внешние рыночные данные")+". Не поток Pocket Option и не OTC-котировка. Сигнал не гарантирует результат; сверь инструмент и цену у брокера.</i>";
}
