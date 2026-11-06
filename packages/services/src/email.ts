// Outbound email over SMTP (SMTP_URL). Never log recipients' tokens or message bodies.
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { log } from './log.js';

let transport: Transporter | undefined;
let transportUrl: string | undefined;

export function mailer(): Transporter | null {
  const url = config().SMTP_URL;
  if (!url) return null;
  if (!transport || transportUrl !== url) {
    transport?.close();
    transport = nodemailer.createTransport(url, { from: config().EMAIL_FROM });
    transportUrl = url;
  }
  return transport;
}

export interface MailMessage { to: string; subject: string; text: string; html?: string }

/** Send an email. Returns false (and logs a safe warning) when SMTP is unavailable or rejects. */
export async function sendMail(m: MailMessage): Promise<boolean> {
  const t = mailer();
  if (!t) {
    log.warn('email_not_configured', { subject: m.subject });
    return false;
  }
  try {
    await t.sendMail({ from: config().EMAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
    return true;
  } catch (err) {
    log.warn('email_send_failed', { subject: m.subject, code: (err as { code?: string }).code ?? 'unknown' });
    return false;
  }
}

/** SMTP connectivity/auth check for diagnostics. */
export async function verifySmtp(timeoutMs = 5000): Promise<{ ok: boolean; detail: string }> {
  const t = mailer();
  if (!t) return { ok: false, detail: 'SMTP_URL is not configured' };
  try {
    await Promise.race([
      t.verify(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return { ok: true, detail: 'SMTP server accepted the connection' };
  } catch (err) {
    return { ok: false, detail: `SMTP check failed (${(err as { code?: string }).code ?? (err as Error).message})` };
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function invitationEmail(p: { to: string; workspaceName: string; inviterEmail: string; role: string; acceptUrl: string; expiresAt: Date }): MailMessage {
  const subject = `You're invited to ${p.workspaceName} on Social Lite`;
  const expires = p.expiresAt.toUTCString();
  const text = [
    `${p.inviterEmail} invited you to join "${p.workspaceName}" on Social Lite as ${p.role}.`,
    '',
    `Accept the invitation: ${p.acceptUrl}`,
    '',
    `Sign in with this email address (${p.to}). The invitation expires ${expires} and can be used once.`,
    'If you were not expecting this, you can ignore this email.',
  ].join('\n');
  const html = `<p>${escapeHtml(p.inviterEmail)} invited you to join <strong>${escapeHtml(p.workspaceName)}</strong> on Social Lite as ${escapeHtml(p.role)}.</p>
<p><a href="${escapeHtml(p.acceptUrl)}">Accept the invitation</a></p>
<p>Sign in with this email address (${escapeHtml(p.to)}). The invitation expires ${escapeHtml(expires)} and can be used once.</p>
<p>If you were not expecting this, you can ignore this email.</p>`;
  return { to: p.to, subject, text, html };
}
