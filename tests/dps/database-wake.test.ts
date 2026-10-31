import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, connect, type Socket } from "node:net";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { closeDatabase, database, query, transaction } from "../../scripts/dps/db/client.ts";

const fixtureUrl = process.env.DPS_TEST_DATABASE_URL;
if (fixtureUrl) {
  const url = new URL(fixtureUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.search !== ""
  ) {
    throw new Error(
      "DPS_TEST_DATABASE_URL must name an isolated local fixture without query overrides",
    );
  }
}

describe.skipIf(!fixtureUrl)("database dependency wake and uncertain writes", () => {
  const admin = new Pool({ connectionString: fixtureUrl, max: 1 });
  let proxy: Awaited<ReturnType<typeof databaseProxy>>;
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const schema = `wake_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query("CREATE TABLE wake_fixture (id text PRIMARY KEY, value integer NOT NULL)");
    const url = new URL(fixtureUrl!);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    proxy = await databaseProxy(url);
    process.env.DATABASE_URL = proxy.url;
  });
  afterAll(async () => {
    await closeDatabase();
    await proxy.close();
    await admin.end();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  test("reconnects after a dependency rejects connections while waking", async () => {
    proxy.rejectConnections(2);
    expect(await query<{ value: number }>("SELECT 42 AS value")).toEqual([{ value: 42 }]);
  });

  test("removes stale idle sockets without crashing, then retains reads and writes", async () => {
    const client = await database().connect();
    const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    client.release();
    await admin.query("SELECT pg_terminate_backend($1)", [result.rows[0]!.pid]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await query("INSERT INTO wake_fixture VALUES ('retained', 7)");
    await closeDatabase();
    expect(await query("SELECT value FROM wake_fixture WHERE id='retained'")).toEqual([
      { value: 7 },
    ]);
  });

  test("does not replay an INSERT whose committed response was lost", async () => {
    proxy.dropCommand("INSERT");
    await expect(query("INSERT INTO wake_fixture VALUES ('uncertain', 1)")).rejects.toThrow();
    expect((await admin.query("SELECT value FROM wake_fixture WHERE id='uncertain'")).rows).toEqual(
      [{ value: 1 }],
    );
  });

  test("does not replay a transaction after losing its COMMIT response", async () => {
    let calls = 0;
    proxy.dropCommand("COMMIT");
    await expect(
      transaction(async (client) => {
        calls += 1;
        await client.query("UPDATE wake_fixture SET value=value+1 WHERE id='uncertain'");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect((await admin.query("SELECT value FROM wake_fixture WHERE id='uncertain'")).rows).toEqual(
      [{ value: 2 }],
    );
    expect(await query("SELECT value FROM wake_fixture WHERE id='retained'")).toEqual([
      { value: 7 },
    ]);
  });

  test("rolls back failed writes and preserves the first SQL error", async () => {
    await expect(
      transaction(async (client) => {
        await client.query("INSERT INTO wake_fixture VALUES ('rolled-back', 9)");
        await client.query("SELECT nonexistent_column FROM wake_fixture");
      }),
    ).rejects.toThrow(/nonexistent_column/);
    expect(await query("SELECT value FROM wake_fixture WHERE id='rolled-back'")).toEqual([]);
  });

  test("fails in bounded time if the dependency stays unavailable", async () => {
    await closeDatabase();
    proxy.rejectConnections(100);
    const started = performance.now();
    await expect(query("SELECT 1")).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(6_000);
    proxy.rejectConnections(0);
    expect(await query("SELECT value FROM wake_fixture WHERE id='uncertain'")).toEqual([
      { value: 2 },
    ]);
  }, 10_000);
});

/** Plaintext fixture proxy can discard a committed response without changing the database. */
async function databaseProxy(upstreamUrl: URL) {
  let rejectedConnections = 0;
  let droppedCommand: string | undefined;
  const sockets = new Set<Socket>();
  const server = createServer((downstream) => {
    if (rejectedConnections > 0) {
      rejectedConnections -= 1;
      downstream.destroy();
      return;
    }
    const upstream = connect(Number(upstreamUrl.port), upstreamUrl.hostname);
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => sockets.delete(socket));
    }
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
    downstream.pipe(upstream);
    let pending = Buffer.alloc(0);
    upstream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const size = pending.readInt32BE(1) + 1;
        if (pending.length < size) return;
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (
          frame[0] === 67 &&
          droppedCommand &&
          frame.subarray(5).toString().startsWith(droppedCommand)
        ) {
          droppedCommand = undefined;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(frame);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const url = new URL(upstreamUrl);
  url.port = String(address.port);
  return {
    url: url.toString(),
    rejectConnections: (count: number) => {
      rejectedConnections = count;
    },
    dropCommand: (command: string) => {
      droppedCommand = command;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
