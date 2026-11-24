// PAPER-01: one contract suite, three targets.
//   1. the paper exchange (always)
//   2. the Binance testnet client talking to a Binance-format fake (always: checks our mapping)
//   3. the Binance testnet client talking to the REAL Spot Testnet (only with keys and
//      SAARTHI_TESTNET_CONTRACT=1, because it places small real testnet orders)
//
// Every test is safe on the real testnet: limit buys rest 20% below the market and are
// cancelled, and anything bought is sold straight back.

import { describe, expect, it } from "vitest";
import { type ExchangeClient, ExchangeError, PaperExchange, floorToStep, roundToTick, seedPaper } from "@saarthi/core";
import { tempDb } from "../../../packages/core/test/helpers.ts";
import { BinanceTestnetClient, makeCcxtTestnet } from "../src/binance.ts";
import { loadExchangeKeys } from "../src/secrets.ts";
import { fakeBinance } from "./fakeBinance.ts";

type Target = { client: ExchangeClient; price: (pair: string) => Promise<number> };

const PAIR = "BTC/USDT";
const uid = () => `sat${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function paperTarget(): Target {
  const { db } = tempDb();
  seedPaper(db);
  const paper = new PaperExchange(db, { price: () => 100_000 });
  return { client: paper, price: async () => 100_000 };
}

function fakeTarget(): Target {
  const { db } = tempDb();
  seedPaper(db);
  const paper = new PaperExchange(db, { price: () => 100_000 });
  return { client: new BinanceTestnetClient(fakeBinance(db, paper)), price: async () => 100_000 };
}

function realTarget(): Target {
  const keys = loadExchangeKeys();
  const client = new BinanceTestnetClient(makeCcxtTestnet(keys.binance!));
  const raw = makeCcxtTestnet(keys.binance!) as unknown as { publicGetTickerPrice(p: object): Promise<{ price: string }> };
  return { client, price: async (pair) => Number((await raw.publicGetTickerPrice({ symbol: pair.replace("/", "") })).price) };
}

const runReal = process.env.SAARTHI_TESTNET_CONTRACT === "1" && loadExchangeKeys().binance !== null;

function contract(label: string, make: () => Target) {
  describe(`PAPER-01 contract: ${label}`, () => {
    it("PAPER-01 ping and market rules", async () => {
      const { client } = make();
      await client.ping();
      const r = await client.rules(PAIR);
      expect(r.pair).toBe(PAIR);
      expect(r.tickSize).toBeGreaterThan(0);
      expect(r.stepSize).toBeGreaterThan(0);
      expect(r.minNotional).toBeGreaterThan(0);
    });

    it("PAPER-01 balances include USDT", async () => {
      const { client } = make();
      const b = await client.balances();
      expect(b.USDT!.free).toBeGreaterThan(10);
    });

    it("PAPER-01 a resting limit buy: placed, found by client ID, listed as open, cancelled, cash released", async () => {
      const { client, price } = make();
      const r = await client.rules(PAIR);
      const px = roundToTick((await price(PAIR)) * 0.8, r.tickSize);
      const qty = floorToStep((r.minNotional * 2) / px + r.stepSize, r.stepSize);
      const before = (await client.balances()).USDT!;
      const id = uid();
      const placed = await client.createOrder({ pair: PAIR, side: "buy", type: "limit", quantity: qty, price: px, clientOrderId: id });
      expect(placed).toMatchObject({ clientOrderId: id, pair: PAIR, side: "buy", type: "limit", status: "open", filled: 0, quantity: qty, price: px });
      expect((await client.getOrder(PAIR, id))!.status).toBe("open");
      expect((await client.openOrders(PAIR)).map((o) => o.clientOrderId)).toContain(id);
      expect((await client.balances()).USDT!.locked).toBeGreaterThan(before.locked);
      const cancelled = await client.cancelOrder(PAIR, id);
      expect(cancelled.status).toBe("canceled");
      expect((await client.getOrder(PAIR, id))!.status).toBe("canceled");
      expect((await client.balances()).USDT!.locked).toBeCloseTo(before.locked, 6);
    });

    it("PAPER-01 an unknown client order ID is null, not an error", async () => {
      const { client } = make();
      expect(await client.getOrder(PAIR, uid())).toBeNull();
      expect(await client.getOco(PAIR, uid())).toBeNull();
    });

    it("PAPER-01 a reused client order ID is refused", async () => {
      const { client, price } = make();
      const r = await client.rules(PAIR);
      const px = roundToTick((await price(PAIR)) * 0.8, r.tickSize);
      const qty = floorToStep((r.minNotional * 2) / px + r.stepSize, r.stepSize);
      const id = uid();
      await client.createOrder({ pair: PAIR, side: "buy", type: "limit", quantity: qty, price: px, clientOrderId: id });
      const again = client.createOrder({ pair: PAIR, side: "buy", type: "limit", quantity: qty, price: px, clientOrderId: id });
      await expect(again).rejects.toBeInstanceOf(ExchangeError);
      await expect(again).rejects.toMatchObject({ retryable: false });
      await client.cancelOrder(PAIR, id);
    });

    it("PAPER-01 an order below the minimum value is refused, not retried", async () => {
      const { client, price } = make();
      const r = await client.rules(PAIR);
      const px = roundToTick((await price(PAIR)) * 0.8, r.tickSize);
      const qty = floorToStep((r.minNotional * 0.3) / px, r.stepSize) || r.stepSize;
      await expect(client.createOrder({ pair: PAIR, side: "buy", type: "limit", quantity: qty, price: px, clientOrderId: uid() })).rejects.toMatchObject({
        retryable: false,
      });
    });

    it("PAPER-01 market buy fills with a price and a fee; OCO placed, read back, cancelled; coins sold back", async () => {
      const { client, price } = make();
      const r = await client.rules(PAIR);
      const last = await price(PAIR);
      const qty = floorToStep((r.minNotional * 3) / last + r.stepSize, r.stepSize);
      const bought = await client.createOrder({ pair: PAIR, side: "buy", type: "market", quantity: qty, clientOrderId: uid() });
      expect(bought.status).toBe("filled");
      expect(bought.filled).toBeCloseTo(qty, 10);
      expect(bought.avgPrice!).toBeGreaterThan(last * 0.95);
      expect(bought.fee).toBeGreaterThan(0);

      const free = floorToStep(Math.min(qty, (await client.balances()).BTC!.free), r.stepSize);
      const list = uid();
      const oco = await client.createOco({
        pair: PAIR,
        quantity: free,
        stopPrice: roundToTick(last * 0.9, r.tickSize),
        stopLimitPrice: roundToTick(last * 0.895, r.tickSize),
        takeProfitPrice: roundToTick(last * 1.1, r.tickSize),
        clientListId: list,
        stopClientOrderId: `${list}-s`,
        takeProfitClientOrderId: `${list}-t`,
      });
      expect(oco).toMatchObject({ clientListId: list, status: "open", stop: { type: "stop_loss_limit", side: "sell" }, takeProfit: { type: "limit_maker", side: "sell" } });
      expect(oco.stop.quantity).toBeCloseTo(free, 10);
      expect((await client.getOco(PAIR, list))!.status).toBe("open");
      await client.cancelOco(PAIR, list);
      const after = (await client.getOco(PAIR, list))!;
      expect(after.status).toBe("done");
      expect(after.stop.status).toBe("canceled");

      const sold = await client.createOrder({ pair: PAIR, side: "sell", type: "market", quantity: free, clientOrderId: uid() });
      expect(sold.status).toBe("filled");
    });
  });
}

contract("paper exchange", paperTarget);
contract("Binance testnet client (Binance-format fake)", fakeTarget);
describe.skipIf(!runReal)("real Binance Spot Testnet (needs keys and SAARTHI_TESTNET_CONTRACT=1)", () => {
  contract("Binance Spot Testnet", realTarget);
});
