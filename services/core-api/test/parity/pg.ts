import { createConnection } from "node:net";

import { Pool, neonConfig, types } from "@neondatabase/serverless";
import { WebSocketServer } from "ws";

import { inTransaction } from '../../src/db.ts';
import type { Query, Row, Transaction } from '../../src/db.ts';

types.setTypeParser(1082, (value: string) => value);
types.setTypeParser(1114, (value: string) => value);
types.setTypeParser(1184, (value: string) => value);

export type LivePg = { query: Query; transaction?: Transaction; close: () => Promise<void> };

type Raw = { rows: Array<Row>; rowCount: number | null };

const rowsOf = (raw: Raw | Array<Raw>) => {
  const result = Array.isArray(raw) ? raw.at(-1) : raw;
  if (!result) {throw new Error("query returned no result");}
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
};

export const livePg = async (url: string, max = 10): Promise<LivePg> => {
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
  await new Promise<void>((resolve) => { server.on("listening", () => { resolve(); }); });
  const address = server.address();
  if (address === null || typeof address === "string") {throw new Error("ws server has no port");}
  const { port } = address;
  neonConfig.webSocketConstructor = globalThis.WebSocket;
  neonConfig.wsProxy = () => `localhost:${port}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  const pool = new Pool({ connectionString: url, ssl: false, max });
  return {
    query: async (text, params = []) => rowsOf(await pool.query(text, params)),
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        return await inTransaction(client, work);
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
};
