// Feed process: two independent price streams, candles, price_state and the
// data-quality check that pauses new signals when the data can't be trusted.
//
//   Feed A: Binance Spot Testnet WebSocket (the venue we trade on)
//   Feed B: a public, keyless mainnet stream from a different source (cross-check only)

import {
  FeedService,
  ReconnectingSocket,
  binanceParser,
  binanceSubscribe,
  loadBaseEnv,
  loadSettingsFile,
  num,
  priceCheckVenue,
  runWorker,
} from "@saarthi/core";
import { makeBinanceRest } from "./binanceRest.ts";

runWorker("feed", () => loadBaseEnv(), ({ env, db, log }) => {
  const risk = loadSettingsFile(env.configDir, "risk.json");
  const strategy = loadSettingsFile(env.configDir, "strategy.json");
  const pairs = strategy.pairs!.value as string[];

  const rest = makeBinanceRest(env.binanceBaseUrl);
  const venueB = priceCheckVenue(env.priceCheckWsUrl, pairs);

  const service = new FeedService({
    db,
    pairs,
    monitor: {
      pairs,
      staleMs: num(risk, "feedStaleSeconds") * 1000,
      disagreementBps: num(risk, "feedDisagreementBps"),
      resumeMs: num(risk, "feedResumeSeconds") * 1000,
    },
    parseA: binanceParser(pairs),
    parseB: venueB.parse,
    fetchKlines: rest.fetchKlines,
    pingExchange: rest.ping,
    log,
  });

  const feedA = new ReconnectingSocket({
    name: "Feed A (Binance testnet)",
    url: env.binanceWsUrl,
    onOpen: (send) => send(binanceSubscribe(pairs)),
    onMessage: (text) => service.handleFeedA(text),
    onStatus: (up, detail) => {
      service.setConnected("A", up, detail);
      log[up ? "info" : "warn"]({}, detail);
    },
  });

  const feedB = new ReconnectingSocket({
    name: `Feed B (${venueB.name})`,
    url: env.priceCheckWsUrl,
    onOpen: (send) => send(venueB.subscribe),
    onMessage: (text) => service.handleFeedB(text),
    onStatus: (up, detail) => {
      service.setConnected("B", up, detail);
      log[up ? "info" : "warn"]({}, detail);
    },
    ping: venueB.ping,
  });

  service.start();
  feedA.start();
  feedB.start();

  return {
    detail: () => service.summary(),
    stop: () => {
      feedA.stop();
      feedB.stop();
      service.stop();
    },
  };
});
