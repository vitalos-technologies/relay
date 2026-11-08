// Server-side HTML → PDF for report exports, using the Playwright/Chromium already installed for E2E tests
// (PLAYWRIGHT_BROWSERS_PATH). Loaded lazily by the WORKER only. The page is our own escaped HTML; JavaScript is
// disabled and every network request is blocked. When Playwright/Chromium is unavailable (e.g. a slim production
// image) renderPdf() returns null and the export is delivered as HTML with an explicit note (no fake PDF).
import { log } from '../log.js';

export async function pdfAvailable(): Promise<boolean> {
  if (process.env.ANALYTICS_PDF === 'off') return false;
  try { await loadPlaywright(); return true; } catch { return false; }
}

async function loadPlaywright(): Promise<{ chromium: { launch(o: Record<string, unknown>): Promise<Browser> } }> {
  const spec = ['@playwright', 'test'].join('/'); // not bundled; resolved at runtime from the installed dev dependency
  return (await import(/* webpackIgnore: true */ spec)) as { chromium: { launch(o: Record<string, unknown>): Promise<Browser> } };
}

interface Browser {
  newContext(o: Record<string, unknown>): Promise<{
    route(pattern: string, h: (route: { abort(): Promise<void>; continue(): Promise<void>; request(): { url(): string } }) => Promise<void>): Promise<void>;
    newPage(): Promise<{ setContent(html: string, o: Record<string, unknown>): Promise<void>; pdf(o: Record<string, unknown>): Promise<Buffer> }>;
  }>;
  close(): Promise<void>;
}

export async function renderPdf(html: string, opts: { timeoutMs?: number } = {}): Promise<Buffer | null> {
  if (process.env.ANALYTICS_PDF === 'off') return null;
  let pw: Awaited<ReturnType<typeof loadPlaywright>>;
  try { pw = await loadPlaywright(); } catch { return null; }
  let browser: Browser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true, timeout: opts.timeoutMs ?? 30_000 });
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    await context.route('**/*', async (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: opts.timeoutMs ?? 30_000 });
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } }));
  } catch (err) {
    log.warn('analytics_pdf_failed', { err: err as Error });
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
