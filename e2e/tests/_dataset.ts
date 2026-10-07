import { expect, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { API } from './_helpers';

/**
 * Dataset lifecycle helpers: the REAL source (plain SQL on the seeded schema)
 * and the product's own API. Fixture: backend/scripts/ci/seed_e2e_dataset_lifecycle.py.
 *
 * The source schema lives in the E2E database (`E2E_SOURCE_DB_URL`, default the
 * CI database) — journeys change rows / columns there and then drive the product.
 */
export const SOURCE_DB_URL = process.env.E2E_SOURCE_DB_URL || 'postgresql://appbi:appbi@localhost:5432/appbi';
export const SCHEMA = 'e2e_dslife';
export const LIFECYCLE = 'E2E lifecycle sales';
export const HOST = 'E2E sandbox snapshot host';

export async function sql(statements: string | string[]): Promise<void> {
  const client = new Client({ connectionString: SOURCE_DB_URL });
  await client.connect();
  try {
    for (const s of Array.isArray(statements) ? statements : [statements]) await client.query(s);
  } finally {
    await client.end();
  }
}

/** The canonical source rows every journey starts from — North 30, South 30. */
export async function resetSource(): Promise<void> {
  await sql([
    `DROP TABLE IF EXISTS ${SCHEMA}.orders`,
    `DROP TABLE IF EXISTS ${SCHEMA}.customers`,
    `CREATE TABLE ${SCHEMA}.customers (id int, name text)`,
    `INSERT INTO ${SCHEMA}.customers VALUES (1, 'An'), (2, 'Binh')`,
    `CREATE TABLE ${SCHEMA}.orders (id int, customer_id int, region text, amount int)`,
    `INSERT INTO ${SCHEMA}.orders VALUES (1, 1, 'North', 10), (2, 1, 'North', 20), (3, 2, 'South', 30)`,
  ]);
}

async function json(res: { status(): number; text(): Promise<string>; json(): Promise<any> }, ok = 200) {
  expect(res.status(), await res.text()).toBe(ok);
  return res.json();
}

export async function datasetByName(request: APIRequestContext, name: string): Promise<{ id: number }> {
  const body = await json(await request.get(`${API}/api/v1/datasets/`));
  const rows: Array<{ id: number; name: string }> = Array.isArray(body) ? body : body.items ?? body.datasets ?? [];
  const found = rows.find((d) => d.name === name);
  expect(found, `fixture dataset "${name}" — run seed_e2e_dataset_lifecycle.py`).toBeTruthy();
  return found!;
}

/** True only when the seed registered a writable BigQuery snapshot host. */
export async function hasSnapshotHost(request: APIRequestContext): Promise<boolean> {
  const body = await json(await request.get(`${API}/api/v1/datasources/`));
  const rows: Array<{ name: string }> = Array.isArray(body) ? body : body.items ?? [];
  return rows.some((d) => d.name === HOST);
}

export async function publishStatus(request: APIRequestContext, id: number) {
  return json(await request.get(`${API}/api/v1/datasets/${id}/publish-status`));
}

/** Wait for a NEW refresh run (newer than `afterRunId`) to reach a terminal
 *  status, then return the dataset's publish status. Keyed on the run ledger so a
 *  click whose request has not landed yet is never mistaken for "settled". */
export async function runSettled(request: APIRequestContext, id: number, afterRunId: number, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [latest] = await refreshRuns(request, id);
    if (latest && Number(latest.id) > afterRunId && latest.status !== 'running') {
      return { run: latest, status: await publishStatus(request, id) };
    }
    expect(Date.now() < deadline, 'no new refresh run settled').toBeTruthy();
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

export async function lastRunId(request: APIRequestContext, id: number): Promise<number> {
  const [latest] = await refreshRuns(request, id);
  return latest ? Number(latest.id) : 0;
}

/** Wait until the dataset leaves `syncing`; returns the settled status. */
export async function settled(request: APIRequestContext, id: number, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let status = await publishStatus(request, id);
  while (status.publish_state === 'syncing' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    status = await publishStatus(request, id);
  }
  expect(status.publish_state, 'sync never settled').not.toBe('syncing');
  return status;
}

export async function refreshRuns(request: APIRequestContext, id: number): Promise<any[]> {
  const body = await json(await request.get(`${API}/api/v1/datasets/${id}/refresh-runs`));
  return Array.isArray(body) ? body : body.runs ?? body.items ?? [];
}

/** {region: amount} as the consumer (a saved chart) reads it now. */
export async function revenueByRegion(request: APIRequestContext, chartId: number): Promise<Record<string, number>> {
  const body = await json(await request.get(`${API}/api/v1/charts/${chartId}/data`));
  const out: Record<string, number> = {};
  for (const row of body.data ?? []) out[String(row.region)] = Number(row.amount);
  return out;
}

export async function chartIdByName(request: APIRequestContext, name: string): Promise<number> {
  const body = await json(await request.get(`${API}/api/v1/charts/`));
  const rows: Array<{ id: number; name: string }> = Array.isArray(body) ? body : body.items ?? body.charts ?? [];
  const found = rows.find((c) => c.name === name);
  expect(found, `fixture chart "${name}"`).toBeTruthy();
  return found!.id;
}
