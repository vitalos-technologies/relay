// V5 support widget (WID) — pure checks: signed time-trap form tokens, visitor visibility predicate, contract invariants,
// and source hygiene (the widget never reads internal notes; the launcher stays tiny and loads the panel lazily).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  WIDGET_MESSAGE_MAX, WIDGET_MIN_FILL_MS, WIDGET_SESSION_IDLE_DAYS, WIDGET_SESSION_TTL_DAYS, WIDGET_TOPICS, WIDGET_VERIFY_MAX_ATTEMPTS, WIDGET_VERIFY_TTL_MINUTES,
} from '../../packages/core/src/contracts/v5-widget.js';
import { SUPPORT_CATEGORY_LABEL, SUPPORT_TICKET_CATEGORIES, RESTRICTED_SUPPORT_CATEGORIES } from '../../packages/core/src/contracts/v4-support.js';

const root = join(__dirname, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://unit:unit@localhost:1/unit';
  process.env.APP_ENV = 'test';
});

describe('form token (time trap)', () => {
  it('accepts a genuine token after the minimum fill time, refuses fast, forged, tampered and expired ones', async () => {
    const { issueFormToken, checkFormToken } = await import('../../packages/services/src/support/widget-session.js');
    const now = Date.now();
    expect(() => checkFormToken(issueFormToken(now - WIDGET_MIN_FILL_MS - 10), now)).not.toThrow();
    expect(() => checkFormToken(issueFormToken(now), now)).toThrow(/wait a moment/);
    const t = issueFormToken(now - 5000);
    const [ts, mac] = t.split('.');
    expect(() => checkFormToken(`${Number(ts) - 1000}.${mac}`, now)).toThrow(/could not be sent/); // re-dated
    expect(() => checkFormToken(`${ts}.${mac!.slice(0, -2)}xx`, now)).toThrow(/could not be sent/);
    expect(() => checkFormToken('garbage', now)).toThrow(/could not be sent/);
    expect(() => checkFormToken(undefined, now)).toThrow(/could not be sent/);
    expect(() => checkFormToken(issueFormToken(now - 7 * 3600_000), now)).toThrow(/expired/);
    expect(() => checkFormToken(issueFormToken(now + 5 * 60_000), now)).toThrow(/expired/); // issued in the future
  });
});

describe('visitor visibility', () => {
  it('matches the own visitor identity, or a VERIFIED email — never member tickets', async () => {
    const { visitorVisibleSql } = await import('../../packages/services/src/support/widget.js');
    const sql = visitorVisibleSql(1, 2);
    expect(sql).toContain(`t.requester_kind = 'visitor'`);
    expect(sql).toContain('t.visitor_id = $1::uuid');
    expect(sql).toContain('$2::citext IS NOT NULL AND t.visitor_email = $2::citext');
  });
});

describe('contract', () => {
  it('topics map onto existing, non-restricted ticket categories; limits are sane', () => {
    for (const t of WIDGET_TOPICS) {
      expect(SUPPORT_TICKET_CATEGORIES).toContain(t.value);
      expect(RESTRICTED_SUPPORT_CATEGORIES).not.toContain(t.value);
    }
    expect(SUPPORT_CATEGORY_LABEL.general).toBe('General question');
    expect(WIDGET_SESSION_IDLE_DAYS).toBeLessThan(WIDGET_SESSION_TTL_DAYS);
    expect(WIDGET_VERIFY_TTL_MINUTES).toBeLessThanOrEqual(15);
    expect(WIDGET_VERIFY_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(WIDGET_MESSAGE_MAX).toBeLessThanOrEqual(10000);
  });
});

describe('source hygiene', () => {
  it('widget services never read internal notes or staff-audience activity', () => {
    for (const f of ['widget.ts', 'widget-session.ts', 'widget-verify.ts']) {
      const s = src(`packages/services/src/support/${f}`);
      expect(s).not.toMatch(/FROM\s+support_notes|JOIN\s+support_notes/i);
      expect(s).not.toMatch(/audience\s*=\s*'staff'/);
    }
  });

  it('the launcher ships no dialog/icon library and loads the panel only via dynamic import', () => {
    const s = src('apps/web/components/support-widget/launcher.tsx');
    expect(s).not.toMatch(/from ['"]lucide-react['"]/);
    expect(s).not.toMatch(/from ['"]@base-ui/);
    expect(s).not.toMatch(/from ['"]motion/);
    expect(s).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+['"]\.\/panel['"]/m); // only `import type` + import('./panel')
    expect(s).toMatch(/import\('\.\/panel'\)/);
    // The only fetch is the unread check inside the idle callback (never on first render).
    expect(s.match(/fetch\(/g)?.length).toBe(1);
    expect(s.indexOf('fetch(')).toBeGreaterThan(s.indexOf('const idle = () =>'));
  });

  it('visitor emails are content-free and links use the URL fragment', () => {
    const s = src('packages/services/src/support/widget-verify.ts');
    expect(s).toContain('/#support-verify=');
    expect(s).not.toMatch(/m\.body|message\.body|\.body\s*\}/); // reply emails never include message text
  });
});
