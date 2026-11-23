import assert from "node:assert/strict";
import { calculateTriangularOpportunities } from "../src/auto-paper.js";

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
process.stdout.write("A|MORE auto-paper unit tests passed\n");
