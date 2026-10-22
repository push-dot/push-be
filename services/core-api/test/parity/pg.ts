import { createConnection } from "node:net";
import type { AddressInfo } from "node:net";

import { Pool, neonConfig, types } from "@neondatabase/serverless";
import { WebSocket, WebSocketServer } from "ws";

import type { Query } from "../../src/db.ts";

types.setTypeParser(1114, (value: string) => value);
types.setTypeParser(1184, (value: string) => value);

export type LivePg = { query: Query; close: () => Promise<void> };

export const livePg = async (url: string): Promise<LivePg> => {
  const target = new URL(url);
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket) => {
    const tcp = createConnection(Number(target.port || 5432), target.hostname);
    socket.on("message", (chunk) => tcp.write(chunk));
    tcp.on("data", (chunk) => socket.readyState === WebSocket.OPEN && socket.send(chunk));
    socket.on("close", () => tcp.destroy());
    tcp.on("close", () => socket.close());
    tcp.on("error", () => socket.close());
  });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  neonConfig.webSocketConstructor = WebSocket as unknown as typeof neonConfig.webSocketConstructor;
  neonConfig.wsProxy = () => `localhost:${port}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  const pool = new Pool({ connectionString: url, ssl: false });
  return {
    query: async (text, params = []) => {
      const raw = await pool.query(text, params as unknown[]);
      const result = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? result.rows.length };
    },
    close: async () => {
      await pool.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
