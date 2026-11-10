// Reads the passwordless sign-in email (D34: one email with a sign-in link AND a 6-digit code) from the local Mailpit
// (infra/compose.yaml, http://localhost:8025) for E2E and integration tests. Local only.
export const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

export interface SignInEmail { id: string; code: string; link: string; subject: string; html: string; text: string; created: string }

interface Summary { ID: string; Created: string; Subject: string; To: Array<{ Address: string }> }

/**
 * Wait for the newest sign-in email to `email` created at or after `since` (ms epoch; allow a little clock skew) and return
 * its code and link. Throws after `timeoutMs`.
 */
export async function waitForSignInEmail(email: string, since: number, timeoutMs = 20_000): Promise<SignInEmail> {
  const deadline = Date.now() + timeoutMs;
  const to = email.toLowerCase();
  let lastErr = 'no message yet';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}" subject:"sign-in code"`)}&limit=10`);
      if (res.ok) {
        const list = (await res.json()) as { messages: Summary[] };
        const hit = list.messages
          .filter((m) => m.To.some((t) => t.Address.toLowerCase() === to) && Date.parse(m.Created) >= since - 3_000)
          .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
        if (hit) {
          const full = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { HTML: string; Text: string; Subject: string; Created: string };
          const code = /(\d{6})/.exec(full.Subject)?.[1] ?? /\b(\d{6})\b/.exec(full.Text)?.[1];
          const link = /href="([^"]*\/login-actions\/action-token[^"]*)"/.exec(full.HTML)?.[1]?.replace(/&amp;/g, '&');
          if (code && link) return { id: hit.ID, code, link, subject: full.Subject, html: full.HTML, text: full.Text, created: full.Created };
          lastErr = 'email without code or link';
        }
      } else lastErr = `mailpit HTTP ${res.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`No sign-in email for ${email} (${lastErr})`);
}
