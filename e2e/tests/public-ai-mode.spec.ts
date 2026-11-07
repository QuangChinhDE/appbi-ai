import { expect, test, type Page } from '@playwright/test';

/**
 * Public link AI mode (PR #105): the publisher picks AppBI AI, the viewer's own Claude, both,
 * or none; the AI Bot tab shows only the sections of the picked modes; the choice is saved and
 * the public page offers exactly what was picked. The viewer panel carries no disclaimer.
 */
const API = '/api/v1';

async function firstDashboard(page: Page): Promise<number> {
  const r = await page.request.get(`${API}/dashboards/`);
  expect(r.ok()).toBeTruthy();
  const list = await r.json();
  const items = Array.isArray(list) ? list : list.items || list.dashboards || [];
  test.skip(items.length === 0, 'no dashboard on this stack');
  return items[0].id;
}

async function openAiTab(page: Page, dashId: number, linkId: number) {
  await page.goto(`/dashboards/${dashId}`);
  await page.getByRole('button', { name: 'More options' }).first().click();
  await page.getByRole('button', { name: 'Public links' }).click();
  await page.getByTestId(`public-link-row-${linkId}`).click();
  await page.getByTestId('public-link-tab-aibot').click();
}

test('publisher picks the assistant mode; the tab and the public page follow it', async ({ page, browser }) => {
  const dashId = await firstDashboard(page);
  const link = await (await page.request.post(`${API}/dashboards/${dashId}/public-links`,
    { data: { name: `e2e ai mode ${Date.now()}` } })).json();
  try {
    await openAiTab(page, dashId, link.id);
    const appbi = page.getByTestId('ai-bot-enable-toggle');
    const claude = page.getByTestId('link-claude-enabled');

    // none picked: no section but the mode picker
    await expect(appbi).toHaveAttribute('aria-checked', 'false');
    await expect(claude).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('ai-bot-appbi-config')).toHaveCount(0);
    await expect(page.getByTestId('link-claude-access')).toHaveCount(0);
    await expect(page.getByTestId('ai-bot-guide-section')).toHaveCount(0);

    // Claude only: Claude section + guide (warned until shared), no AppBI AI config
    await claude.click();
    await expect(page.getByTestId('link-claude-access')).toBeVisible();
    await expect(page.getByTestId('ai-bot-appbi-config')).toHaveCount(0);
    await expect(page.getByTestId('ai-bot-guide-unused')).toBeVisible();
    await page.getByTestId('link-claude-share-guide').click();
    await expect(page.getByTestId('ai-bot-guide-unused')).toHaveCount(0);

    // both: every section, the both-hint, cards side by side with even spacing
    await appbi.click();
    await expect(page.getByTestId('ai-bot-appbi-config')).toBeVisible();
    await expect(page.getByTestId('ai-mode-both-hint')).toBeVisible();
    const gaps = await page.getByTestId('ai-bot-guide-section').evaluate((el) => {
      const kids = [...(el.parentElement as HTMLElement).children].map((c) => c.getBoundingClientRect());
      return kids.slice(1).map((r, i) => Math.round(r.top - kids[i].bottom));
    });
    expect(new Set(gaps).size, `section gaps ${gaps}`).toBe(1);
    const [a, b] = await Promise.all([appbi.boundingBox(), claude.boundingBox()]);
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? 1))).toBeLessThan(1);
    expect(Math.abs((a?.height ?? 0) - (b?.height ?? 1))).toBeLessThan(1);

    // back to Claude only, save, and the choice is stored
    await appbi.click();
    await page.getByTestId('public-link-save').click();
    await expect(page.getByText(/Link updated|Đã cập nhật/)).toBeVisible();
    const saved = (await (await page.request.get(`${API}/dashboards/${dashId}/public-links`)).json())
      .find((l: { id: number }) => l.id === link.id);
    expect(saved.appearance_config.ai_bot_enabled === true).toBe(false);
    expect(saved.appearance_config.mcp_access).toMatchObject({ enabled: true, share_guide: true });

    // the public page offers Claude only: no engine switcher, no disclaimer
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anon = await ctx.newPage();
    await anon.goto(`/d/${link.token}`);
    await anon.getByTestId('ai-bot-open').click();
    await expect(anon.getByTestId('ai-bot-panel')).toBeVisible();
    await expect(anon.getByRole('button', { name: 'AppBI AI' })).toHaveCount(0);
    await expect(anon.getByTestId('claude-chat-history-notice')).toHaveCount(0);
    await expect(anon.getByText(/AppBI không thấy và không lưu|AppBI never sees/)).toHaveCount(0);
    await ctx.close();
  } finally {
    await page.request.delete(`${API}/dashboards/${dashId}/public-links/${link.id}`);
  }
});
