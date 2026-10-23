import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { test } from "node:test";

import { livePg } from "./parity/pg.ts";

// A loopback-only stand-in for Postgres that speaks just enough of the v3 wire protocol
// (trust auth, simple + extended query) to drive the livePg websocket bridge without a real DB.
const msg = (type: string, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s: string) => Buffer.from(s + "\0");
const ready = msg("Z", Buffer.from("I"));
const rowDesc = (cols: [string, number][]) => msg("T", Buffer.concat([int16(cols.length), ...cols.map(([name, oid]) =>
  Buffer.concat([cstr(name), int32(0), int16(0), int32(oid), int16(-1), int32(-1), int16(0)]))]));
const dataRow = (values: string[]) => msg("D", Buffer.concat([int16(values.length), ...values.flatMap((v) => [int32(Buffer.byteLength(v)), Buffer.from(v)])]));
const result = (cols: [string, number][], values: string[]) => Buffer.concat([rowDesc(cols), dataRow(values), msg("C", cstr("SELECT 1"))]);

async function fakePostgres() {
  const queries: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          buf = buf.subarray(buf.readInt32BE(0));
          started = true;
          socket.write(Buffer.concat([msg("R", int32(0)), ready]));
          continue;
        }
        if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
        const type = String.fromCharCode(buf[0]);
        const body = buf.subarray(5, 1 + buf.readInt32BE(1));
        buf = buf.subarray(1 + buf.readInt32BE(1));
        if (type === "Q") {
          const text = body.subarray(0, body.length - 1).toString();
          queries.push(text);
          const sets = text.split(";").map((_, i) => result([["n", 23], ["at", 1114]], [String(i + 1), "2026-10-22 01:02:03"]));
          socket.write(Buffer.concat([...sets, ready]));
        } else if (type === "P") {
          queries.push(body.subarray(1, body.indexOf(0, 1)).toString());
        } else if (type === "S") {
          socket.write(Buffer.concat([msg("1", Buffer.alloc(0)), msg("2", Buffer.alloc(0)), result([["v", 25]], ["bound"]), ready]));
        } else if (type === "X") {
          socket.end();
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `postgres://u:p@127.0.0.1:${(server.address() as AddressInfo).port}/db`,
    queries,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

test("livePg bridges queries over the neon websocket proxy and keeps timestamps as text", async () => {
  const fake = await fakePostgres();
  const pg = await livePg(fake.url);
  try {
    const simple = await pg.query("SELECT 1 AS n");
    assert.deepEqual(simple, { rows: [{ n: 1, at: "2026-10-22 01:02:03" }], rowCount: 1 });

    const multi = await pg.query("SELECT 1; SELECT 2");
    assert.deepEqual(multi.rows, [{ n: 2, at: "2026-10-22 01:02:03" }], "multi-statement results resolve to the last set");

    const bound = await pg.query("SELECT $1::text AS v", ["bound"]);
    assert.deepEqual(bound.rows, [{ v: "bound" }]);
    assert.deepEqual(fake.queries, ["SELECT 1 AS n", "SELECT 1; SELECT 2", "SELECT $1::text AS v"]);
  } finally {
    await pg.close();
    await fake.close();
  }
});
