// CFG-07: the LAN gateway always stamps the caller's real address, overwriting any it sent.

import { describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { CLIENT_HEADER, startLanGateway } from "../../../scripts/lanGateway.ts";

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)));
}

describe("CFG-07 LAN gateway", () => {
  it("CFG-07 a caller can't pretend to be this computer: the header is replaced with its real address", async () => {
    const seen: (string | string[] | undefined)[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers[CLIENT_HEADER]);
      res.end(`ok ${req.method} ${req.url}`);
    });
    const target = await listen(upstream);
    const gw = await startLanGateway({ listenHost: "127.0.0.1", listenPort: 0, targetPort: target });
    const port = (gw.address() as net.AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/backend/risk?x=1`, { headers: { [CLIENT_HEADER]: "spoofed" } });
    expect(await res.text()).toBe("ok GET /backend/risk?x=1");
    expect(seen).toEqual(["127.0.0.1"]);
    gw.close();
    upstream.close();
  });

  it("CFG-07 WebSocket upgrades (Next.js hot reload) pass through with the real address too", async () => {
    let raw = "";
    const upstream = net.createServer((sock) => {
      sock.on("data", (d) => {
        raw += d.toString();
        if (raw.includes("\r\n\r\n")) sock.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      });
    });
    const target = await listen(upstream);
    const gw = await startLanGateway({ listenHost: "127.0.0.1", listenPort: 0, targetPort: target });
    const port = (gw.address() as net.AddressInfo).port;
    const reply = await new Promise<string>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () => c.write(`GET /_next/webpack-hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${CLIENT_HEADER}: spoofed\r\n\r\n`));
      let got = "";
      c.on("data", (d) => (got += d.toString()));
      c.on("end", () => resolve(got));
    });
    expect(reply).toMatch(/^HTTP\/1.1 101/);
    expect(raw).toContain(`${CLIENT_HEADER}: 127.0.0.1`);
    expect(raw).not.toContain("spoofed");
    gw.close();
    upstream.close();
  });

  it("CFG-07 while Next.js is still starting, the phone gets a plain 502 message", async () => {
    const gw = await startLanGateway({ listenHost: "127.0.0.1", listenPort: 0, targetPort: 1 });
    const res = await fetch(`http://127.0.0.1:${(gw.address() as net.AddressInfo).port}/`);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/starting/);
    gw.close();
  });
});
