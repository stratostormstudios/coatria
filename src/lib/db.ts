import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const globalDb = globalThis as unknown as { coatriaPool?: Pool };
export function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  return globalDb.coatriaPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: Math.max(1,Math.min(10,Number(process.env.DATABASE_POOL_MAX)||5)), idleTimeoutMillis: 20000, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
}
export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
  return database().query<T>(sql, values);
}
export async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await database().connect();
  try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
