import { expect, test, type Page } from '@playwright/test';
import { API } from './_helpers';
import {
  LIFECYCLE, chartIdByName, datasetByName, hasSnapshotHost, refreshRuns, resetSource, revenueByRegion,
  lastRunId, runSettled, sql, SCHEMA,
} from './_dataset';

/**
 * Dataset lifecycle — Sync & Publish against a REAL source and a REAL snapshot host.
 *
 *   J2  Sync & Publish from the dataset page → progress → Published → Refresh
 *       history → the consumer (a saved chart) reads the published generation.
 *   J3  The source rows change → Sync again → the generation advances and the
 *       consumer reads the new values (no reload of anything but the API).
 *   J4  A duplicate one-side key at the source → Sync FAILS with the reason,
 *       the consumer KEEPS the previous generation; the source is repaired →
 *       Sync re-reads it (a refused candidate is never resumed) → corrected
 *       generation publishes and the consumer reads it.
 *
 * FIXTURE: backend/scripts/ci/seed_e2e_dataset_lifecycle.py. Sync & Publish can
 * only materialize into BigQuery; the seed registers a host only when a sandbox
 * write credential + a disposable dataset are configured. Without one these
 * journeys skip BY NAME — they are NOT run in CI (no BigQuery there).
 */
const CHART = 'E2E lifecycle revenue by region';
const SYNC = /^(Sync & Publish|Đồng bộ & Phát hành|Re-publish|Phát hành lại)$/;

async function syncFromTheBanner(page: Page, id: number) {
  const before = await lastRunId(page.request, id);
  await page.goto(`/datasets/${id}`);
  // The banner's own button publishes directly (no config modal).
  const banner = page.getByText(/unpublished changes|chưa phát hành|is a draft|bản nháp|Last sync failed|bị lỗi/).first();
  if (await banner.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: SYNC }).last().click();
  } else {
    await page.getByRole('button', { name: SYNC }).first().click();          // header → config modal
    await expect(page.getByRole('heading', { name: /^(Sync & Publish|Đồng bộ & Phát hành)$/ })).toBeVisible();
    // The modal's own confirm sits next to "Save config" (a banner button with the
    // same label stays behind the overlay).
    await page.getByRole('button', { name: /^(Save config|Lưu cấu hình)$/ })
      .locator('xpath=following-sibling::button[1]').click();
  }
  return runSettled(page.request, id, before);
}

test.describe('Dataset lifecycle — Sync & Publish', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);

  test.beforeEach(async ({ request }) => {
    test.skip(!(await hasSnapshotHost(request)),
      'no writable BigQuery snapshot host (CI has none) — certified against the sandbox host');
  });

  test('J2 Sync & Publish publishes a generation the consumer reads', async ({ page, request }) => {
    await resetSource();
    const { id } = await datasetByName(request, LIFECYCLE);
    const chart = await chartIdByName(request, CHART);
    const before = await publishStatusGen(request, id);

    const sync = syncFromTheBanner(page, id);
    await expect(page.getByText(/Syncing data|Đang đồng bộ dữ liệu|Syncing…|Đang đồng bộ…/).first())
      .toBeVisible({ timeout: 30_000 });                                  // progress is shown
    const { status } = await sync;
    expect(status.publish_state).toBe('published');
    expect(status.published_generation).not.toBe(before);

    await page.reload();
    await expect(page.getByText(/^(Published|Đã phát hành)/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^(History|Lịch sử)$/ }).click();
    await expect(page.getByText(/Refresh history|Lịch sử refresh/).first()).toBeVisible();
    await expect(page.getByText(/^(Success|Thành công)$/).first()).toBeVisible();

    const [run] = await refreshRuns(request, id);
    expect(run.status).toBe('success');
    expect(Number(run.generation)).toBe(Number(status.published_generation));
    expect(await revenueByRegion(request, chart)).toEqual({ North: 30, South: 30 });
  });

  test('J3 a source row change reaches the consumer through a new generation', async ({ page, request }) => {
    const { id } = await datasetByName(request, LIFECYCLE);
    const chart = await chartIdByName(request, CHART);
    const before = (await publishStatusGen(request, id))!;
    await sql(`UPDATE ${SCHEMA}.orders SET amount = 100 WHERE id = 3`);    // South 30 → 100
    expect(await revenueByRegion(request, chart), 'published data does not move until a publish')
      .toEqual({ North: 30, South: 30 });

    const { status } = await syncFromTheBanner(page, id);
    expect(status.publish_state).toBe('published');
    expect(Number(status.published_generation)).toBeGreaterThan(Number(before));
    expect(await revenueByRegion(request, chart)).toEqual({ North: 30, South: 100 });
  });

  test('J4 a refused candidate keeps the old generation; the repaired source publishes', async ({ page, request }) => {
    const { id } = await datasetByName(request, LIFECYCLE);
    const chart = await chartIdByName(request, CHART);
    const good = (await publishStatusGen(request, id))!;
    const valuesBefore = await revenueByRegion(request, chart);

    // 1) break the one side of orders → customers (many_to_one): customer 1 twice,
    //    and change a fact row so a wrongly-published candidate would be visible.
    await sql([`INSERT INTO ${SCHEMA}.customers VALUES (1, 'An again')`,
               `UPDATE ${SCHEMA}.orders SET amount = 50 WHERE id = 1`]);   // North would become 70
    const { status: failed } = await syncFromTheBanner(page, id);
    expect(failed.publish_state).toBe('sync_failed');
    expect(Number(failed.published_generation)).toBe(Number(good));      // still pinned
    await page.reload();
    await expect(page.getByText(/Last sync failed|Lần đồng bộ gần nhất bị lỗi/).first())
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Semantic health/).first()).toBeVisible();  // the reason, not a generic error
    expect(await revenueByRegion(request, chart), 'the consumer keeps the last good generation')
      .toEqual(valuesBefore);
    const [refused] = await refreshRuns(request, id);
    expect(refused.status).toBe('failed');
    expect(String(refused.error)).toMatch(/Semantic health/);

    // 2) repair the source and sync again: the candidate is RE-READ (never resumed)
    await sql(`DELETE FROM ${SCHEMA}.customers WHERE name = 'An again'`);
    const { status: fixed } = await syncFromTheBanner(page, id);
    expect(fixed.publish_state).toBe('published');
    expect(Number(fixed.published_generation)).toBeGreaterThan(Number(good));
    expect(Number(fixed.published_generation)).not.toBe(Number(refused.generation));
    expect(await revenueByRegion(request, chart)).toEqual({ ...valuesBefore, North: 70 });
  });

  test('J5 source schema drift is reconciled before the build — never a silent success', async ({ page, request }) => {
    const { id } = await datasetByName(request, LIFECYCLE);
    const chart = await chartIdByName(request, CHART);
    const good = (await publishStatusGen(request, id))!;
    const values = await revenueByRegion(request, chart);

    // ADD a source column → the build proceeds, the table is flagged for review.
    await sql(`ALTER TABLE ${SCHEMA}.orders ADD COLUMN channel text`);
    const { status: added } = await syncFromTheBanner(page, id);
    expect(added.publish_state).toBe('published');
    const status = await (await request.get(`${API}/api/v1/datasets/${id}/tables/source-status`)).json();
    const orders = status.tables.find((t: any) => t.table_name === 'orders');
    expect(orders.code, 'a new source column is surfaced, not ignored').toBe('SOURCE_SCHEMA_CHANGED');
    await page.goto(`/datasets/${id}`);
    await page.getByText('orders', { exact: true }).first().click();
    await expect(page.getByText(/có cột mới mà dataset chưa biết/).first()).toBeVisible({ timeout: 30_000 });

    // DROP a column the model uses → explicit drift failure; the old generation keeps serving.
    const published = (await publishStatusGen(request, id))!;
    await sql(`ALTER TABLE ${SCHEMA}.orders DROP COLUMN region`);
    const { status: drifted, run } = await syncFromTheBanner(page, id);
    expect(drifted.publish_state).toBe('sync_failed');
    expect(Number(drifted.published_generation)).toBe(Number(published));
    expect(String(run.error)).toMatch(/SOURCE_SCHEMA_DRIFT.*region/);
    await page.reload();
    await expect(page.getByText(/SOURCE_SCHEMA_DRIFT/).first()).toBeVisible({ timeout: 30_000 });
    expect(await revenueByRegion(request, chart)).toEqual(values);

    // RESTORE → publishes again.
    await sql([`ALTER TABLE ${SCHEMA}.orders DROP COLUMN channel`,
               `ALTER TABLE ${SCHEMA}.orders ADD COLUMN region text`,
               `UPDATE ${SCHEMA}.orders SET region = CASE WHEN id = 3 THEN 'South' ELSE 'North' END`]);
    const { status: back } = await syncFromTheBanner(page, id);
    expect(back.publish_state).toBe('published');
    expect(Number(back.published_generation)).toBeGreaterThan(Number(good));
    await resetSource();
  });
});

async function publishStatusGen(request: any, id: number): Promise<number | null> {
  const { publishStatus } = await import('./_dataset');
  return (await publishStatus(request, id)).published_generation ?? null;
}
