import { getDemoAccount, applyDemoResult } from "./demo.js";

const TRADE_STAKE = 10;
const PAYOUT = 0.8;
const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
export const TIMEFRAMES = {
  "1m": { label: "1 минута", expiryMs: 60000, rank: 1 },
  "5m": { label: "5 минут", expiryMs: 300000, rank: 2 },
  "15m": { label: "15 минут", expiryMs: 900000, rank: 3 },
  "30m": { label: "30 минут", expiryMs: 1800000, rank: 4 }
};
async function candles(symbol, interval) {
  const url = "https://api.binance.com/api/v3/klines?symbol=" + symbol + "&interval=" + interval + "&limit=60";
  try {
    const response = await fetch(url, {headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
    if (!response.ok) throw new Error("Binance candles HTTP " + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length < 30) throw new Error("Недостаточно свечей Binance");
    return rows.map(x => ({open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]),closeTime:Number(x[6])}));
  } catch (binanceError) {
    const minutes={"1m":1,"5m":5,"15m":15,"30m":30}[interval];
    const pair=symbol.replace("BTC","XBT");
    if(minutes) {
      try {
        const response=await fetch("https://api.kraken.com/0/public/OHLC?pair="+pair+"&interval="+minutes,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
        if(!response.ok)throw new Error("Kraken OHLC HTTP "+response.status);
        const payload=await response.json();
        if(payload.error?.length)throw new Error(payload.error.join(", "));
        const rows=Object.entries(payload.result||{}).find(([key])=>key!=="last")?.[1]||[];
        if(rows.length>=30)return rows.map(x=>({open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[6]),closeTime:Number(x[0])*1000+minutes*60000-1}));
      } catch(krakenError) {
        if(!Number.isFinite(minutes))throw new Error("Binance: "+binanceError.message+"; Kraken: "+krakenError.message);
      }
    }
    try {
      const bar={"1m":"1m","5m":"5m","15m":"15m","30m":"30m"}[interval];
      if(!bar)throw new Error("Неподдерживаемый таймфрейм");
      const instrument=symbol.replace("USDT","-USDT");
      const response=await fetch("https://www.okx.com/api/v5/market/candles?instId="+instrument+"&bar="+bar+"&limit=60",{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
      if(!response.ok)throw new Error("OKX candles HTTP "+response.status);
      const payload=await response.json();
      if(payload.code!=="0"||!Array.isArray(payload.data))throw new Error(payload.msg||"OKX candles response error");
      const rows=payload.data.slice().reverse();
      if(rows.length<30)throw new Error("OKX: недостаточно свечей");
      return rows.map(x=>({open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]),closeTime:Number(x[0])+({"1m":60000,"5m":300000,"15m":900000,"30m":1800000}[interval])-1}));
    } catch(okxError) {
      throw new Error("Binance: "+binanceError.message+"; резервные свечи недоступны: "+okxError.message);
    }
  }
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
function analyze(rows) {
  const closed=rows.slice(0,-1),closes=closed.map(x=>x.close),last=closed[closed.length-1],prev=closed[closed.length-2];
  const fast=ema(closes.slice(-30),9),slow=ema(closes.slice(-40),21),momentum=rsi(closes,14);
  let up=0,down=0;const upReasons=[],downReasons=[];
  if(fast>slow){up++;upReasons.push("EMA 9 выше EMA 21");}
  if(fast<slow){down++;downReasons.push("EMA 9 ниже EMA 21");}
  if(momentum>=52&&momentum<=68){up++;upReasons.push("RSI в бычьей зоне ("+momentum.toFixed(1)+")");}
  if(momentum<=48&&momentum>=32){down++;downReasons.push("RSI в медвежьей зоне ("+momentum.toFixed(1)+")");}
  if(last.close>last.open&&last.close>prev.close){up++;upReasons.push("положительная свечная динамика");}
  if(last.close<last.open&&last.close<prev.close){down++;downReasons.push("отрицательная свечная динамика");}
  const direction=up>down?"UP":down>up?"DOWN":null,score=Math.max(up,down);
  return {direction:direction&&score>=3?direction:null,score,reasons:direction==="UP"?upReasons:direction==="DOWN"?downReasons:[],entry:last.close,candleCloseTime:last.closeTime,
    diagnostics:{ema:fast>slow?"бычья":fast<slow?"медвежья":"нейтральная",rsi:Number(momentum.toFixed(1)),candle:last.close>last.open&&last.close>prev.close?"бычья":last.close<last.open&&last.close<prev.close?"медвежья":"нейтральная",score,direction:direction||"нет"}};
}
export async function openTradingDemo(env,chatId,requestedTimeframe="auto",requestedPair="ALL") {
  if(!env.SUBSCRIBERS)throw new Error("KV namespace SUBSCRIBERS is not configured");
  if(await env.SUBSCRIBERS.get("user:stop:"+chatId))throw new Error("A|MORE STOP включён. Возобнови работу кнопкой в Telegram-боте.");
  const key="paper:trading:"+chatId,active=await env.SUBSCRIBERS.get(key);
  if(active)return {active:JSON.parse(active)};
  const account=await getDemoAccount(env,chatId);
  if(account.trading.balance<TRADE_STAKE)throw new Error("На демо-балансе A|MORE Signals недостаточно средств.");
  const intervals=requestedTimeframe==="auto"?Object.keys(TIMEFRAMES):[requestedTimeframe];
  if(!TIMEFRAMES[requestedTimeframe]&&requestedTimeframe!=="auto")throw new Error("Неизвестный таймфрейм.");
  if(requestedPair!=="ALL"&&!PAIRS.includes(requestedPair))throw new Error("Неизвестная валютная пара.");
  const selectedPairs=requestedPair==="ALL"?PAIRS:[requestedPair];
  const tasks=[];for(const interval of intervals)for(const symbol of selectedPairs)tasks.push({interval,symbol});
  const results=await Promise.all(tasks.map(async task=>{try{return {...task,signal:analyze(await candles(task.symbol,task.interval))};}catch(e){return {...task,error:task.symbol+" "+task.interval+": "+e.message};}}));
  const candidates=results.filter(x=>x.signal?.direction).map(x=>({symbol:x.symbol,timeframe:x.interval,...x.signal}));
  candidates.sort((a,b)=>b.score-a.score||TIMEFRAMES[b.timeframe].rank-TIMEFRAMES[a.timeframe].rank);
  const diagnostics=results.filter(x=>x.signal).map(x=>({symbol:x.symbol,timeframe:x.interval,...x.signal.diagnostics}));
  const errors=results.filter(x=>x.error).map(x=>x.error),best=candidates[0];
  if(!best)return {none:true,errors,diagnostics,requestedTimeframe};
  const entry=await currentPrice(best.symbol);
  const now=Date.now(),duration=TIMEFRAMES[best.timeframe].expiryMs;
  const trade={id:String(chatId)+":"+now,symbol:best.symbol,timeframe:best.timeframe,direction:best.direction,entry,stake:TRADE_STAKE,payout:PAYOUT,openedAt:now,settleAt:now+duration,expiryMs:duration,reasons:best.reasons,score:best.score};
  await env.SUBSCRIBERS.put(key,JSON.stringify(trade),{expirationTtl:Math.ceil(duration/1000)+300});
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
      const exit=await currentPrice(trade.symbol);if(!Number.isFinite(exit)||exit<=0)continue;
      const outcome=exit===trade.entry?"draw":(trade.direction==="UP"?exit>trade.entry:exit<trade.entry)?"win":"loss";
      const pnl=outcome==="win"?trade.stake*trade.payout:outcome==="loss"?-trade.stake:0;
      await applyDemoResult(env,item.name.slice("paper:trading:".length),"trading",pnl,outcome);
      await env.SUBSCRIBERS.delete(item.name);
      const label=outcome==="win"?"✅ ПРОГНОЗ СБЫЛСЯ":outcome==="loss"?"❌ ПРОГНОЗ НЕ СБЫЛСЯ":"➖ НИЧЬЯ";
      const text="⏱ <b>A|MORE Signals — результат демо-прогноза</b>\n"+label+"\nПара: <b>"+trade.symbol+"</b>\nТаймфрейм: <b>"+(trade.timeframe||"1m")+"</b>\nПрогноз: <b>"+trade.direction+"</b>\nВход: "+trade.entry+"\nЦена после экспирации: "+exit+"\nP/L: <b>"+(pnl>0?"+":"")+pnl.toFixed(2)+" USDT</b>\n<i>Демо-модель. Это не исполнение у брокера.</i>";
      if(env.TELEGRAM_BOT_TOKEN)await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:item.name.slice("paper:trading:".length),text,parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📊 A|MORE Arbitrage",callback_data:"scan"},{text:"📈 A|MORE Signals",callback_data:"trade_menu"}],[{text:"💼 Демо-балансы",callback_data:"demo"},{text:"🧾 Статистика",callback_data:"stats"}]]}})});
    }catch(e){console.error("Paper trade settlement:",item.name,e);}
  }
}
export function formatOpenTrade(trade) {
  const tf=trade.timeframe||"1m";
  return "📈 <b>A|MORE SIGNALS — ДЕМО-ПРОГНОЗ</b>\nПара: <b>"+trade.symbol+"</b>\nТаймфрейм: <b>"+tf+" ("+TIMEFRAMES[tf].label+")</b>\nПрогноз: <b>"+(trade.direction==="UP"?"🟢 ВВЕРХ ↑":"🔴 ВНИЗ ↓")+"</b>\nВиртуальная ставка: <b>"+trade.stake+" USDT</b>\nЦена входа: <b>"+trade.entry+"</b>\nЭкспирация: <b>"+TIMEFRAMES[tf].label+"</b>\nФакторы: "+trade.reasons.join("; ")+"\nОценка модели: "+trade.score+"/3 подтверждений\n\n<i>Экспериментальная стратегия. Точность не подтверждена статистически.</i>";
}
