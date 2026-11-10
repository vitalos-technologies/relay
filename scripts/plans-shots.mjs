#!/usr/bin/env node
// Marketing evidence (DEV/LOCAL ONLY), deviceScaleFactor 2, light only → evidence/plans/<name>-<width>.png: hero, product
// cards mid-scroll, each Explore modal, Connect your tools, pricing, comparison, FAQ, /signup for Free and Standard, at 1440
// and 390 px, plus the hero with the OS asking for dark (<name>-1440-os-dark.png, must still be light). Refuses an unstyled page.
//   node scripts/plans-shots.mjs   (BASE=http://localhost:3000)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE = process.env.BASE ?? 'http://localhost:3000';
const OUT = process.env.OUT ?? 'evidence/plans';
mkdirSync(OUT, { recursive: true });

async function assertStyled(page, marketing) {
  const r = await page.evaluate((mkt) => {
    const css = performance.getEntriesByType('resource').filter((e) => /\/_next\/static\/.*\.css(\?|$)/.test(e.name));
    const h1 = document.querySelector('h1');
    return {
      css: css.length, cssFailed: css.filter((e) => e.responseStatus && e.responseStatus !== 200).length,
      h1Weight: h1 ? getComputedStyle(h1).fontWeight : null,
      tokens: mkt ? getComputedStyle(document.querySelector('.mkt')).getPropertyValue('--v5-primary').trim() : getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  }, marketing);
  const ok = r.css > 0 && r.cssFailed === 0 && !!r.tokens && r.bodyBg !== 'rgba(0, 0, 0, 0)' && (marketing ? r.h1Weight === '800' : true);
  if (!ok) throw new Error(`page is not styled — refusing to capture: ${JSON.stringify(r)}`);
  return r;
}

const browser = await chromium.launch();
const shotEl = async (page, sel, name) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(700); await page.locator(sel).first().screenshot({ path: `${OUT}/${name}.png` }); };
try {
  // Light only (user request 2026-11-10): the marketing page ignores the OS scheme, so it is captured with `dark` requested
  // too, to prove it stays light.
  for (const [width, scheme] of [[1440, 'light'], [390, 'light'], [1440, 'dark']]) {
    const tag = `${width}${scheme === 'dark' ? '-os-dark' : ''}`;
    const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await assertStyled(page, true);
    await page.waitForTimeout(900); // hero entrance
    await page.screenshot({ path: `${OUT}/hero-${tag}.png` });
    if (scheme === 'dark') { await ctx.close(); continue; }
    // Let every scroll-in reveal run once (element captures of tall sections don't scroll through them).
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 90)); } });
    await page.waitForTimeout(700);
    // Element captures scroll the page; keep the sticky header out of them.
    await page.addStyleTag({ content: '.mkt header.sticky { position: static !important; }' });
    // Product cards mid-scroll: the second card sliding over the first (sticky stack on wide screens).
    const y = await page.evaluate(() => { const li = document.querySelectorAll('.mkt-stack > li'); return li[1].getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.45; });
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/product-midscroll-${tag}.png` });
    for (const id of ['publishing', 'inbox', 'analytics', 'ai-assistant']) {
      const btn = page.getByTestId(`mkt-explore-${id}`);
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await page.waitForFunction(() => { const i = document.querySelector('[role=dialog] figure img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/explore-${id}-${tag}.png` });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    }
    await shotEl(page, '#integrations', `integrations-${tag}`);
    await shotEl(page, '#pricing', `pricing-${tag}`);
    await page.getByTestId('mkt-compare').click();
    await shotEl(page, '[data-testid=mkt-comparison]', `comparison-${tag}`);
    await page.getByTestId('mkt-faq-free').getByRole('button').click();
    await page.getByTestId('mkt-faq-trial').getByRole('button').click();
    await shotEl(page, '#faq', `faq-${tag}`);
    await page.goto(`${BASE}/signup?plan=free`, { waitUntil: 'networkidle' });
    await assertStyled(page, false);
    await page.screenshot({ path: `${OUT}/signup-free-${tag}.png`, fullPage: true });
    await page.goto(`${BASE}/signup?plan=standard&seats=3`, { waitUntil: 'networkidle' });
    await assertStyled(page, false);
    await page.screenshot({ path: `${OUT}/signup-standard-${tag}.png`, fullPage: true });
    console.log(`captured ${tag}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
