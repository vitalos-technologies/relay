'use client';
// V5 support widget — new conversation. Visitors give a name, a contact email (used to reply; it proves nothing and opens
// nothing by itself) and a message; signed-in customers write from their account and pick one of their workspaces (the
// server re-validates it). The submission id is kept until the message is accepted, so a retry never creates a duplicate.
// Hidden honeypot field + server-signed time trap; clear privacy note.
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { WIDGET_TOPICS, type WidgetConversation, type WidgetSessionInfo } from '@social-lite/core/contracts/v5-widget';
import { Button } from '@/components/ui-v5/button';
import { Field, Input, NativeSelect, Textarea, describedBy } from '@/components/ui-v5/field';
import { friendly, newId, wcall, WidgetError } from './client';
import { FileChips, FilePicker, useFiles } from './files';

export function ComposeView({ info, onCreated, refreshInfo, onVerify }: {
  info: WidgetSessionInfo; onCreated: (c: WidgetConversation) => void; refreshInfo: () => Promise<WidgetSessionInfo | null>; onVerify?: () => void;
}) {
  const member = info.mode === 'member' ? info.member : null;
  const [name, setName] = useState(info.visitor?.name ?? '');
  const [email, setEmail] = useState(info.visitor?.email ?? '');
  const [topic, setTopic] = useState<string>('general');
  const [workspace, setWorkspace] = useState(member?.default_workspace_id ?? '');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState('');
  const [clientId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<WidgetError | null>(null);
  const files = useFiles(info.limits);
  const fe = err?.fieldErrors ?? {};

  const send = async (attempt = 0): Promise<void> => {
    setBusy(true); setErr(null);
    const current = attempt ? await refreshInfo() : info;
    try {
      const body = member
        ? { client_id: clientId, workspace_id: workspace || undefined, message, topic, attachment_ids: files.readyIds, website, diagnostics: { route: window.location.pathname } }
        : { client_id: clientId, name, email, message, topic, attachment_ids: files.readyIds, website, form_token: (current ?? info).form_token, diagnostics: { route: window.location.pathname } };
      const c = await wcall<WidgetConversation>('/api/widget/conversations', { method: 'POST', body, csrf: (current ?? info).csrf });
      onCreated(c);
    } catch (e) {
      const we = e instanceof WidgetError ? e : new WidgetError('error', friendly(e));
      // Time trap / expired form: fetch a fresh token and try once more (same submission id → no duplicate).
      if (attempt === 0 && (we.fieldErrors.form_token === 'too_fast' || we.fieldErrors.form_token === 'expired')) {
        await new Promise((r) => setTimeout(r, we.fieldErrors.form_token === 'too_fast' ? 1600 : 0));
        return send(1);
      }
      setErr(we);
    } finally { setBusy(false); }
  };

  const max = info.limits.message_max;
  return (
    <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={(e) => { e.preventDefault(); if (!busy && !files.busy) void send(); }}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {member ? (
          <p className="text-sm text-v5-muted">Signed in as <span className="font-medium text-v5-fg">{member.name}</span> ({member.email}). Your message also appears under Help → My requests.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            <Field id="wid-name" label="Name" error={fe.name}>
              <Input id="wid-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} required {...describedBy('wid-name', null, fe.name)} />
            </Field>
            <Field id="wid-email" label="Email" error={fe.email}>
              <Input id="wid-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required {...describedBy('wid-email', null, fe.email)} />
            </Field>
          </div>
        )}
        {member && member.workspaces.length > 1 ? (
          <Field id="wid-ws" label="Workspace" error={fe.workspace_id}>
            <NativeSelect id="wid-ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} {...describedBy('wid-ws', null, fe.workspace_id)}>
              {member.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </NativeSelect>
          </Field>
        ) : null}
        <Field id="wid-topic" label="Topic">
          <NativeSelect id="wid-topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
            {WIDGET_TOPICS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </NativeSelect>
        </Field>
        <Field id="wid-message" label="Message" error={fe.message} hint={message.length > max * 0.8 ? `${message.length} / ${max}` : undefined}>
          <Textarea id="wid-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={max} rows={4} required
            {...describedBy('wid-message', message.length > max * 0.8 ? 1 : null, fe.message)} />
        </Field>
        {/* Honeypot: people never see or fill this. */}
        <div aria-hidden className="absolute -left-[9999px] size-px overflow-hidden">
          <label htmlFor="wid-website">Website</label>
          <input id="wid-website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>
        {member || info.visitor ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <FilePicker id="wid-compose-file" accept={info.limits.attachment_types} disabled={files.files.length >= info.limits.attachments_per_message}
                onPick={(l) => void files.add(l, { csrf: info.csrf, workspaceId: member ? workspace || null : null })} />
              <span className="text-xs text-v5-muted">Screenshots, PDFs or text files, up to {Math.round(info.limits.attachment_max_bytes / 1048576)} MB</span>
            </div>
            <FileChips files={files.files} onRemove={files.remove} />
          </div>
        ) : null}
        {!member ? (
          <p className="text-xs leading-relaxed text-v5-muted" data-testid="widget-privacy">
            We use your name, email and messages to reply, plus the page you’re on and your browser type. A cookie keeps this
            conversation in this browser for up to 30 days. Conversations are kept for up to two years after they’re closed.
            {info.privacy_url ? <> <a href={info.privacy_url} className="font-medium text-v5-primary-text underline underline-offset-2">Privacy</a></> : null}
          </p>
        ) : null}
        {err && !Object.keys(fe).filter((k) => k !== 'form_token').length ? <p role="alert" className="text-sm font-medium text-[color:var(--v5-warn)]">{friendly(err)}</p> : null}
      </div>
      <div className="border-t border-v5-border px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <Button type="submit" className="w-full" disabled={busy || files.busy || !message.trim() || (!member && (!name.trim() || !email.trim()))}>
          {busy ? <><Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />Sending…</> : 'Send message'}
        </Button>
        <p className="mt-2 text-center text-xs text-v5-muted">
          {info.availability.email_replies ? 'We’ll reply here and email you when we do.' : 'Replies appear here in this browser.'}
        </p>
        {!member && onVerify && info.availability.email_replies && !info.conversations.length ? (
          <p className="mt-1 text-center text-xs">
            <button type="button" onClick={onVerify} className="font-medium text-v5-primary-text underline-offset-2 hover:underline">Wrote to us from another device? Continue here</button>
          </p>
        ) : null}
      </div>
    </form>
  );
}
