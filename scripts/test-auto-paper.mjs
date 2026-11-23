import assert from "node:assert/strict";
import { AutoPaperState, calculateTriangularOpportunities, applyAdverseSlippage, executionLatencyAllowed } from "../src/auto-paper.js";

const tickers = [
  {symbol:"BTCUSDT",bid1Price:"99900",ask1Price:"100000",bid1Size:"10",ask1Size:"10"},
  {symbol:"ETHBTC",bid1Price:"0.05",ask1Price:"0.0501",bid1Size:"100",ask1Size:"100"},
  {symbol:"ETHUSDT",bid1Price:"5100",ask1Price:"5110",bid1Size:"100",ask1Size:"100"}
];

const rows = calculateTriangularOpportunities(tickers, {
  feePercent: 0.1, minNetPercent: 0.25, minDepthUsdt: 25
});
assert.equal(rows.length, 1);
assert.equal(rows[0].strategy, "triangular");
assert.equal(rows[0].direction, "USDT_BTC_ASSET_USDT");
assert.ok(rows[0].net > 0.25);
assert.equal(calculateTriangularOpportunities(tickers, {
  feePercent: 0.1, minNetPercent: 10, minDepthUsdt: 25
}).length, 0);
assert.equal(calculateTriangularOpportunities(tickers.slice(0, 2), {
  feePercent: 0.1, minNetPercent: 0.25, minDepthUsdt: 25
}).length, 0);

const reverseTickers = [
  {symbol:"BTCUSDT",bid1Price:"100000",ask1Price:"100100",bid1Size:"10",ask1Size:"10"},
  {symbol:"ETHBTC",bid1Price:"0.051",ask1Price:"0.0511",bid1Size:"100",ask1Size:"100"},
  {symbol:"ETHUSDT",bid1Price:"4890",ask1Price:"4900",bid1Size:"100",ask1Size:"100"}
];
const reverseRows = calculateTriangularOpportunities(reverseTickers, {
  feePercent: 0.1, minNetPercent: 0.25, minDepthUsdt: 400000
});
assert.equal(reverseRows.length, 1);
assert.equal(reverseRows[0].direction, "USDT_ASSET_BTC_USDT");
const gateRows = calculateTriangularOpportunities(tickers, {
  feePercent: 0.2, minNetPercent: 0.25, minDepthUsdt: 25, exchange: "Gate.io"
});
assert.equal(gateRows[0].exchange, "Gate.io");
process.stdout.write("A|MORE auto-paper unit tests passed\n");

const storageData = new Map();
const durable = new AutoPaperState({storage:{
  get: async key => storageData.get(key),
  put: async (key,value) => { storageData.set(key,value); }
}}, {});
const doRequest = (path,body={}) => durable.fetch(new Request("https://auto-paper-state/"+path,{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
}));
const savedState = {enabled:true,startedAt:100,endsAt:200,tradeCount:3};
assert.equal((await (await doRequest("write",{state:savedState})).json()).ok,true);
assert.deepEqual((await (await doRequest("read")).json()).state,savedState);
assert.equal((await (await doRequest("daily-count",{day:"2026-11-23",legacyCount:2})).json()).count,2);
assert.equal((await (await doRequest("increment-daily",{day:"2026-11-23",legacyCount:0})).json()).count,3);
assert.equal((await (await doRequest("daily-count",{day:"2026-11-23",legacyCount:0})).json()).count,3);
process.stdout.write("A|MORE Durable Object state tests passed\n");

const askStress = applyAdverseSlippage([[100,2],[101,3]],"buy",10);
assert.equal(askStress[0][0],100.1);
assert.equal(askStress[1][0],101.101);
const bidStress = applyAdverseSlippage([[100,2]],"sell",10);
assert.equal(bidStress[0][0],99.9);
assert.equal(executionLatencyAllowed(4999,5000),true);
assert.equal(executionLatencyAllowed(5001,5000),false);
assert.equal(executionLatencyAllowed(-1,5000),false);
process.stdout.write("A|MORE execution realism tests passed\n");
