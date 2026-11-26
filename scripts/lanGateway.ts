// A tiny reverse proxy that sits in front of Next.js when ALLOW_LAN=true.
// It's the only thing listening on the network. For every request it records the
// caller's real address in x-saarthi-client (overwriting whatever the caller sent),
// so the API can tell this computer from a phone and ask the phone for the PIN.
// WebSocket upgrades (Next.js hot reload) are piped through too.

import http from "node:http";
import net from "node:net";

export const CLIENT_HEADER = "x-saarthi-client";

export function startLanGateway(opts: { listenHost: string; listenPort: number; targetPort: number }): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, [CLIENT_HEADER]: req.socket.remoteAddress ?? "unknown" };
    const upstream = http.request({ host: "127.0.0.1", port: opts.targetPort, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("The dashboard is starting. Refresh in a few seconds.");
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const up = net.connect(opts.targetPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]!.toLowerCase() !== CLIENT_HEADER) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`${CLIENT_HEADER}: ${req.socket.remoteAddress ?? "unknown"}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.listenPort, opts.listenHost, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
