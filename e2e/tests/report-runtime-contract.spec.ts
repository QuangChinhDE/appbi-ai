/**
 * The Report Runtime's CALCULATION contract, executed in a real browser (no backend).
 *
 * BI Core decides WHAT, the report decides HOW. The runtime (backend/app/services/
 * report_code/runtime.js) receives DTOs and may draw, sort and format them; it must NOT:
 * - add rows up into a total, or pick "the" value of a many-row result;
 * - convert a percent by guessing from the size of the value (the semantic format decides,
 *   with the platform's convention: a percent measure is a RATIO, shown x100);
 * - present a period change it computes as an official metric, or compare an incomplete period;
 * - show a refused binding (a lock the engine could not apply) as "no data".
 * And it must tell a reader when the rows are a Top-N or a cut result.
 */
import { test, expect, type Frame, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const RUNTIME = fs.readFileSync(path.resolve(__dirname, '../../backend/app/services/report_code/runtime.js'), 'utf8');

const BODY = `
<div id="pct" data-rac-value="ratio"></div>
<div id="sign" data-rac-value="whole" data-rac-opts='{"kind":"percent","decimals":1}'></div>
<div id="many" data-rac-value="many"></div>
<div id="row" data-rac-value="many" data-rac-row="SP"></div>
<div id="kpi" data-rac-viz="kpi" data-rac-bind="time"></div>
<div id="kpip" data-rac-viz="kpi" data-rac-bind="timep"></div>
<div id="ref" data-rac-viz="bar" data-rac-bind="refused"></div>
<ul><li data-rac-repeat="top"><span data-rac-cell="d"></span> <b data-rac-cell="m"></b></li></ul>
<div id="bars" data-rac-viz="bar" data-rac-bind="top"></div>`;

const F = {
  ratio: [{ key: 'm0', label: '% đạt KH', role: 'measure', kind: 'number', format: { kind: 'percent' } }],
  whole: [{ key: 'm0', label: 'OCC', role: 'measure', kind: 'number', aggregation: 'avg' }],
  cat: [{ key: 'd0', label: 'Bang', role: 'dimension', kind: 'string' }, { key: 'm0', label: 'Doanh thu', role: 'measure', kind: 'number', aggregation: 'sum' }],
  time: [{ key: 'd0', label: 'Tháng', role: 'dimension', kind: 'date', grain: 'month' }, { key: 'm0', label: 'Doanh thu', role: 'measure', kind: 'number', aggregation: 'sum' }],
};
const dto = (id: string, fields: unknown[], rows: unknown[], extra: Record<string, unknown> = {}) =>
  ({ bindingId: id, title: id, kind: '', status: 'ready', fields, rows, partial: [], notApplied: [], provenance: {}, ...extra });
const DTOS = {
  ratio: dto('ratio', F.ratio, [{ m0: 1.6 }]), // 160% of plan: a ratio above 1.5 is still a ratio
  whole: dto('whole', F.whole, [{ m0: 72.5 }]), // OCC already in percent points
  many: dto('many', F.cat, [{ d0: 'SP', m0: 100 }, { d0: 'RJ', m0: 50 }]),
  time: dto('time', F.time, [{ d0: '2026-07-01', m0: 100 }, { d0: '2026-08-01', m0: 110 }]),
  timep: dto('timep', F.time, [{ d0: '2026-07-01', m0: 100 }, { d0: '2026-08-01', m0: 40 }], { partial: ['2026-08-01'] }),
  refused: { bindingId: 'refused', title: 'r', kind: '', status: 'refused', rows: [], fields: [], error: 'Biểu đồ này không áp được một giới hạn bắt buộc' },
  top: dto('top', F.cat, [{ d0: 'SP', m0: 100 }, { d0: 'RJ', m0: 50 }], { topN: { n: 2, direction: 'top' } }),
};

async function mount(page: Page): Promise<Frame> {
  // Served from a real URL, as the isolated report origin serves it (the runtime's navigation
  // guard proves itself with a same-document hash navigation, which a srcdoc cannot hold).
  const doc = `<!doctype html><html><head><meta charset="utf-8"><script>${RUNTIME.replace(/<\/script/gi, '<\\/script')}</script></head><body>${BODY}</body></html>`;
  await page.route('http://report.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
    body: r.request().url().endsWith('/doc') ? doc : '<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="width:900px;height:900px"></iframe></body></html>' }));
  await page.goto('http://report.test/host');
  await page.evaluate((dtos) => new Promise<void>((resolve) => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    (window as any).__issues = [];
    f.onload = () => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        if (e.data?.type === 'error') (window as any).__issues.push(e.data.message);
        if (e.data?.type === 'ready') {
          Object.entries(dtos).forEach(([id, d]) => ch.port1.postMessage({ type: 'data', id, dto: d }));
          setTimeout(resolve, 800);
        }
      };
      f.contentWindow!.postMessage({ type: 'rac:init', v: 1, context: { filters: [], state: {}, bindings: Object.keys(dtos).map((id) => ({ id, title: id, kind: '' })), mode: 'studio', locale: 'vi-VN' } }, '*', [ch.port2]);
    };
    f.src = 'http://report.test/doc';
  }), DTOS);
  return page.frames().find((fr) => fr !== page.mainFrame())!;
}

test('the report runtime formats, selects and labels - it never computes an official number', async ({ page }) => {
  const f = await mount(page);
  const text = (sel: string) => f.locator(sel).innerText();
  // percent: the semantic format decides (ratio x100), never the size of the value
  expect(await text('#pct')).toBe('160%');
  // a "%" only the design writes is a sign: the BI Core's number as returned
  expect(await text('#sign')).toBe('72,5%');
  // many rows, no row chosen: no client total, no first-row pick
  expect(await text('#many')).toBe('—');
  expect(await f.locator('#many').getAttribute('data-rac-prov')).toBe('needs-kpi');
  expect(await text('#row')).toBe('100');
  const issues: string[] = await page.evaluate(() => (window as any).__issues);
  expect(issues.some((m) => /BI Core tính/.test(m)), 'the author is told to bind a KPI').toBeTruthy();
  // a period change is labelled a report calculation, and never shown for an incomplete period
  await expect(f.locator('#kpi .rac-kpi-value')).toHaveText('110');
  await expect(f.locator('#kpi .rac-kpi-delta')).toHaveAttribute('data-rac-prov', 'derived');
  await expect(f.locator('#kpi')).toContainText('tính trong báo cáo');
  await expect(f.locator('#kpip .rac-kpi-delta')).toHaveCount(0);
  await expect(f.locator('#kpip')).toContainText('chưa trọn kỳ');
  // a refused binding says why, never "no data"
  await expect(f.locator('#ref')).toContainText('không áp được một giới hạn bắt buộc');
  // a Top-N result says it is one, on a list and on a chart
  await expect(f.locator('li[data-rac-prov="cut"]')).toContainText('Top 2');
  await expect(f.locator('#bars .rac-cut')).toContainText('Top 2');
  await expect(f.locator('li[data-rac-clone="top"]:not([data-rac-prov="cut"])')).toHaveCount(2);
});
