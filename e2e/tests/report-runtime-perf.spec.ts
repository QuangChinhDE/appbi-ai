/**
 * The Report Runtime's LOADING contract (report-data-perf P3/P4), in a real browser, no backend.
 *
 * - The document tells the host which bindings it SHOWS (`ready.need`, then `need` messages):
 *   a binding inside a hidden tab is not asked until the tab opens; one the author's JS
 *   subscribes to always is.
 * - A capped list (data-rac-limit) asks for that many rows only.
 * - A long list is drawn in chunks: the first rows at once, every row in the end.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const RUNTIME = fs.readFileSync(path.resolve(__dirname, '../../backend/app/services/report_code/runtime.js'), 'utf8');

const BODY = `
<style>.tab{display:none}.tab.on{display:block}.pg{visibility:hidden;height:0;overflow:hidden}.pg.on{visibility:visible;height:auto}</style>
<div class="pg" id="p3"><b data-rac-value="vpage"></b></div>
<b id="kpi" data-rac-value="k"></b>
<div class="tab" id="t2"><div data-rac-viz="bar" data-rac-bind="hidden"></div></div>
<details id="d"><summary>x</summary><b data-rac-value="indetails"></b></details>
<table><tbody><tr data-rac-repeat="capped" data-rac-limit="50"><td data-rac-cell="d0"></td></tr></tbody></table>
<ul><li data-rac-repeat="long"><span data-rac-cell="d0"></span></li></ul>`;

async function mount(page: Page) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><script>${RUNTIME.replace(/<\/script/gi, '<\\/script')}</script></head><body>${BODY}</body></html>`;
  await page.route('http://report.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
    body: r.request().url().endsWith('/doc') ? doc : '<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="width:900px;height:900px"></iframe></body></html>' }));
  await page.goto('http://report.test/host');
  await page.evaluate(() => new Promise<void>((resolve) => {
    const f = document.getElementById('f') as HTMLIFrameElement;
    const w = window as any;
    w.__msgs = [];
    f.onload = () => {
      const ch = new MessageChannel();
      w.__port = ch.port1;
      ch.port1.onmessage = (e) => { w.__msgs.push(e.data); if (e.data?.type === 'ready') resolve(); };
      f.contentWindow!.postMessage({ type: 'rac:init', v: 1, context: { filters: [], state: {}, bindings: ['k', 'hidden', 'capped', 'long', 'indetails', 'vpage'].map((id) => ({ id, title: id, kind: '' })), mode: 'view', locale: 'vi-VN' } }, '*', [ch.port2]);
    };
    f.src = 'http://report.test/doc';
  }));
  return page.frames().find((fr) => fr !== page.mainFrame())!;
}

test('the document asks only for what it shows, caps capped lists and draws long lists in chunks', async ({ page }) => {
  const frame = await mount(page);
  const ready = await page.evaluate(() => (window as any).__msgs.find((m: any) => m.type === 'ready'));
  expect(ready.need).toEqual(['capped', 'k', 'long']);
  expect(ready.limits).toEqual({ capped: 50 });

  // the tab opens: the host is told, once, that "hidden" is now needed
  await frame.evaluate(() => document.getElementById('t2')!.classList.add('on'));
  await page.waitForTimeout(300);
  await expect.poll(() => page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === 'need').pop()?.ids))
    .toEqual(['capped', 'hidden', 'k', 'long']);
  // a closed <details> keeps its boxes (content-visibility) but is not shown: asked when opened
  await frame.evaluate(() => { (document.getElementById('d') as HTMLDetailsElement).open = true; });
  await expect.poll(() => page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === 'need').pop()?.ids))
    .toEqual(['capped', 'hidden', 'indetails', 'k', 'long']);
  // a page hidden with visibility:hidden + height:0 (report 23's pages) is not shown either
  await frame.evaluate(() => document.getElementById('p3')!.classList.add('on'));
  await expect.poll(() => page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === 'need').pop()?.ids))
    .toEqual(['capped', 'hidden', 'indetails', 'k', 'long', 'vpage']);

  // a 450-row list: 100 rows at once, all 450 a moment later
  const rows = Array.from({ length: 450 }, (_, i) => ({ d0: `R${i}` }));
  await page.evaluate((rows) => (window as any).__port.postMessage({ type: 'data', id: 'long', dto: {
    bindingId: 'long', title: 'long', kind: '', status: 'ready', rows, partial: [], notApplied: [], provenance: {},
    fields: [{ key: 'd0', label: 'Mã', role: 'dimension', kind: 'string' }] } }), rows);
  await expect.poll(() => frame.locator('li[data-rac-clone="long"]').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(100);
  await expect.poll(() => frame.locator('li[data-rac-clone="long"]').count(), { timeout: 10_000 }).toBe(450);
  await expect(frame.locator('li[data-rac-clone="long"]').nth(449)).toHaveText('R449');

  // the author's JS subscribing to a binding makes it needed even with no element
  await frame.evaluate(() => (window as any).rac.bind('extra', () => {}));
  await expect.poll(() => page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === 'need').pop()?.ids))
    .toContain('extra');
});
