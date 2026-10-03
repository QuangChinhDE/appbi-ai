import { expect, test } from '@playwright/test';

/**
 * A4 — the PRODUCTION TypeScript CSV serializer (lib/export-csv.ts), exercised
 * through a real browser download. A Python re-implementation cannot catch a
 * regression in the real exporter; this parses the actual downloaded bytes.
 *
 * FIXTURE: seed_e2e_data_state.py public link `e2e-data-state-table` — a TABLE
 * chart over rows whose cells are the serializer's edge cases: a comma+quote,
 * an embedded newline, a leading-'=' formula-injection payload, Unicode
 * diacritics, a NULL. allow_data_export is on, so the per-tile "Export data"
 * button is present on the logged-out public view.
 */
test('the public CSV download encodes specials, Unicode, NULL and injection', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/d/e2e-data-state-table');
  await expect(page.getByText('E2E orders detail (csv)').first()).toBeVisible({ timeout: 30_000 });
  // The table must have rendered its rows before export (it serializes rendered rows).
  await expect(page.getByText('=SUM(A1)')).toBeVisible({ timeout: 30_000 });

  const tile = page.locator('.group').filter({ has: page.getByText('=SUM(A1)') }).first();
  await tile.hover();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export data (CSV)' }).first().click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf-8');

  // UTF-8 BOM so Excel reads Vietnamese (the first char).
  expect(raw.charCodeAt(0)).toBe(0xfeff);
  const body = raw.slice(1);

  // Headers present.
  expect(body).toContain('id');
  expect(body).toContain('note');
  expect(body).toContain('label');
  // comma+quote → wrapped in quotes with doubled inner quotes.
  expect(body).toContain('"quote ""x"", comma"');
  // embedded newline → the cell is quoted (the literal newline survives inside quotes).
  expect(body).toMatch(/"line1\r?\nline2"/);
  // Unicode diacritics preserved.
  expect(body).toContain('Áo thun');
  // formula-injection neutralized: a leading apostrophe.
  expect(body).toContain("'=SUM(A1)");
  // NULL → empty cell (row 3 has an empty note between its id and label).
  expect(body).toMatch(/\r?\n3,,/);
});
