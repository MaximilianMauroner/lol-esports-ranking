import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (pool) return pool;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  // pg removes an idle client on error. Handle the event so a sleeping dependency cannot
  // terminate the web process; never log a connection URL or query values.
  pool.on("error", () => console.warn("postgres_idle_connection_closed"));
  pool.on("connect", (client) => {
    // Checked-out clients also emit errors after rejecting an in-flight query.
    client.on("error", () => console.warn("postgres_connection_closed"));
  });
  return pool;
}

const WAKE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

/** Retry only before application SQL. A lost write or COMMIT response is never replayed. */
async function readyClient(): Promise<PoolClient> {
  for (let attempt = 0; ; attempt += 1) {
    let client: PoolClient | undefined;
    try {
      client = await database().connect();
      const probe = { text: "SELECT 1", query_timeout: 5_000 };
      await client.query(probe);
      return client;
    } catch (error) {
      client?.release(true);
      const delay = WAKE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isConnectionFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  return (
    (typeof code === "string" &&
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
        "57P01",
        "57P02",
        "57P03",
        "08006",
      ].includes(code)) ||
    /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect|Query read timeout)$/.test(
      error.message,
    )
  );
}

export async function closeDatabase(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}

export async function query<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await readyClient();
  let failed = false;
  try {
    const result = await client.query<T>(text, values);
    return result.rows;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    client.release(failed);
  }
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await readyClient();
  let failed = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failed = true;
    // Preserve the original error, including an uncertain commit, if the socket is gone.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release(failed);
  }
}
