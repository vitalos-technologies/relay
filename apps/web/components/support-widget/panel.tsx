'use client';
// V5 support widget — the conversation panel (code-split; loaded by ./launcher only after interaction or idle).
// Accessible dialog (Base UI via components/ui-v5/sheet): focus trapped and returned, Esc + labelled close button.
// Mobile: full-screen sheet that follows the visual viewport, so the composer stays above the on-screen keyboard.
// Desktop: a floating panel at the bottom-right. Talks only to /api/widget/** (the V4 support service underneath).
// Copy is honest: "Send us a message" unless staffed chat is configured; no online status, response times, typing or
// read indicators; email is only promised when email delivery is actually configured.
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Loader2, MessageSquarePlus } from 'lucide-react';
import type { WidgetConversation, WidgetConversationSummary, WidgetSessionInfo } from '@social-lite/core/contracts/v5-widget';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui-v5/sheet';
import { Button } from '@/components/ui-v5/button';
import { Field, Input, describedBy } from '@/components/ui-v5/field';
import { cn } from '@/components/ui-v5/cn';
import { friendly, wcall, WidgetError } from './client';
import { ComposeView } from './compose';
import { ConversationView, STATUS_LABEL } from './conversation';

export interface SupportPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  verifyToken: string | null;
  onVerifyHandled: () => void;
  scopeClass?: string;
  onUnread: (n: number) => void;
}

type View =
  | { name: 'home' }
  | { name: 'compose' }
  | { name: 'conversation'; reference: string; initial: WidgetConversation | null }
  | { name: 'verify'; step: 'email' | 'code' | 'link'; email?: string };

export function SupportPanel({ open, onOpenChange, verifyToken, onVerifyHandled, scopeClass, onUnread }: SupportPanelProps) {
  const [info, setInfo] = useState<WidgetSessionInfo | null>(null);
  const [loadErr, setLoadErr] = useState<WidgetError | null>(null);
  const [view, setView] = useState<View>({ name: 'home' });
  const [live, setLive] = useState('');

  const refresh = useCallback(async (): Promise<WidgetSessionInfo | null> => {
    try {
      const i = await wcall<WidgetSessionInfo>('/api/widget/session');
      setInfo(i); setLoadErr(null);
      onUnread(i.conversations.filter((c) => c.unread).length);
      return i;
    } catch (e) {
      setLoadErr(e instanceof WidgetError ? e : new WidgetError('error', friendly(e)));
      return null;
    }
  }, [onUnread]);

  // Fetch the session whenever the panel opens (external data; state is set when the response arrives).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on open, not derived state
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  // Keep the full-screen sheet inside the visual viewport (on-screen keyboard) on small screens.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!open || !vv) return;
    const root = document.documentElement;
    const apply = () => { root.style.setProperty('--wid-vvh', `${Math.round(vv.height)}px`); root.style.setProperty('--wid-vvt', `${Math.round(vv.offsetTop)}px`); };
    apply();
    vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply);
    return () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); root.style.removeProperty('--wid-vvh'); root.style.removeProperty('--wid-vvt'); };
  }, [open]);

  const announce = useCallback((t: string) => setLive(t), []);
  const back = () => { setView({ name: 'home' }); void refresh(); };
  const openConv = (reference: string, initial: WidgetConversation | null = null) => setView({ name: 'conversation', reference, initial });
  const hasList = !!info?.conversations.length;
  // A one-time link (#support-verify=…) takes over until it is handled; with no conversations, home is the compose form.
  const effective: View = verifyToken ? { name: 'verify', step: 'link' } : view.name === 'home' && info && !hasList ? { name: 'compose' } : view;
  const canBack = effective.name !== 'home' && (hasList || effective.name === 'verify' || effective.name === 'conversation');
  const title = effective.name === 'conversation' ? (info?.conversations.find((c) => c.reference === effective.reference)?.subject ?? 'Conversation')
    : effective.name === 'verify' ? 'Continue a conversation'
      : effective.name === 'compose' && hasList ? 'New message' : (info?.availability.title ?? 'Send us a message');

  return (
    <Sheet open={open} onOpenChange={(o) => onOpenChange(o)}>
      <SheetContent
        side="full"
        closeLabel="Close chat"
        data-testid="support-panel"
        className={cn(scopeClass, 'gap-0 overflow-hidden p-0',
          'max-sm:bottom-auto max-sm:top-[var(--wid-vvt,0px)] max-sm:h-[var(--wid-vvh,100dvh)]',
          'sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[min(40rem,calc(100dvh-3rem))] sm:w-[25rem] sm:rounded-2xl sm:border')}
      >
        <header className="flex items-center gap-3 border-b border-v5-border py-3 pl-3 pr-14">
          {canBack ? (
            <button type="button" onClick={back} className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-v5-muted outline-none hover:bg-v5-raised hover:text-v5-fg focus-visible:outline-2 focus-visible:outline-v5-ring">
              <ArrowLeft aria-hidden className="size-5" /><span className="sr-only">Back to conversations</span>
            </button>
          ) : (
            <span className="ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-v5-primary-soft">
              {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark, fixed size */}
              <img src="/brand/relay-mark.svg" alt="" width={20} height={20} className="size-5" />
            </span>
          )}
          <div className="min-w-0">
            <SheetTitle className="truncate text-base">{title}</SheetTitle>
            <SheetDescription className="truncate text-xs">
              {info?.availability.staffed ? 'Relay support team' : 'Relay support'}
            </SheetDescription>
          </div>
        </header>
        <div aria-live="polite" className="sr-only">{live}</div>
        {!info ? (
          loadErr ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
              <p className="text-sm text-v5-muted">{loadErr.code === 'offline' ? 'You’re offline. Connect to send us a message.' : 'The chat couldn’t load.'}</p>
              <Button variant="outline" size="sm" onClick={() => void refresh()}>Try again</Button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center" role="status"><Loader2 aria-hidden className="size-5 animate-spin text-v5-muted motion-reduce:animate-none" /><span className="sr-only">Loading</span></div>
          )
        ) : effective.name === 'compose' ? (
          <ComposeView info={info} refreshInfo={refresh} onCreated={(c) => { void refresh(); openConv(c.reference, c); }} onVerify={() => setView({ name: 'verify', step: 'email' })} />
        ) : effective.name === 'conversation' ? (
          <ConversationView key={effective.reference} reference={effective.reference} info={info} initial={effective.initial} announce={announce} />
        ) : effective.name === 'verify' ? (
          <VerifyView info={info} step={effective.step} email={effective.email} verifyToken={verifyToken} refresh={refresh}
            onStep={(step, email) => setView({ name: 'verify', step, email })}
            onDone={(ref) => { onVerifyHandled(); if (ref) openConv(ref); else setView({ name: 'home' }); }} />
        ) : (
          <Home info={info} onOpen={(r) => openConv(r)} onNew={() => setView({ name: 'compose' })} onVerify={() => setView({ name: 'verify', step: 'email' })} refresh={refresh} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function Home({ info, onOpen, onNew, onVerify, refresh }: {
  info: WidgetSessionInfo; onOpen: (ref: string) => void; onNew: () => void; onVerify: () => void; refresh: () => Promise<unknown>;
}) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const end = async () => {
    setBusy(true);
    try { await wcall('/api/widget/session/end', { method: 'POST', csrf: info.csrf }); await refresh(); } finally { setBusy(false); setConfirmEnd(false); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <h3 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-v5-muted">Your conversations</h3>
        <ul className="flex flex-col">
          {info.conversations.map((c) => <ConvRow key={c.reference} c={c} onOpen={onOpen} />)}
        </ul>
      </div>
      <div className="flex flex-col gap-2 border-t border-v5-border px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <Button className="w-full" onClick={onNew}><MessageSquarePlus aria-hidden />New message</Button>
        {info.mode === 'visitor' ? (
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs">
            {info.availability.email_replies ? <button type="button" className="font-medium text-v5-primary-text underline-offset-2 hover:underline" onClick={onVerify}>Continue from another device</button> : null}
            {info.visitor ? (confirmEnd ? (
              <span className="flex items-center gap-2 text-v5-muted">End chat in this browser?
                <button type="button" disabled={busy} className="font-semibold text-v5-fg underline underline-offset-2" onClick={() => void end()}>End</button>
                <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setConfirmEnd(false)}>Keep</button>
              </span>
            ) : <button type="button" className="text-v5-muted underline-offset-2 hover:underline" onClick={() => setConfirmEnd(true)}>End chat on this device</button>) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConvRow({ c, onOpen }: { c: WidgetConversationSummary; onOpen: (ref: string) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(c.reference)} data-testid="conversation-row"
        className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-v5-fg">{c.subject}</span>
          <span className="block truncate text-xs text-v5-muted">
            {STATUS_LABEL[c.status]} · {new Date(c.updated_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}{c.workspace ? ` · ${c.workspace.name}` : ''}
          </span>
        </span>
        {c.unread ? <span className="rounded-full bg-v5-primary px-2 py-0.5 text-[11px] font-semibold text-v5-on-primary">New reply</span> : null}
        <ChevronRight aria-hidden className="size-4 shrink-0 text-v5-muted" />
      </button>
    </li>
  );
}

function VerifyView({ info, step, email: initialEmail, verifyToken, refresh, onStep, onDone }: {
  info: WidgetSessionInfo; step: 'email' | 'code' | 'link'; email?: string; verifyToken: string | null; refresh: () => Promise<WidgetSessionInfo | null>;
  onStep: (s: 'email' | 'code' | 'link', email?: string) => void; onDone: (ref: string | null) => void;
}) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<WidgetError | null>(null);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e instanceof WidgetError ? e : new WidgetError('error', friendly(e))); } finally { setBusy(false); } };
  const fe = err?.fieldErrors ?? {};

  if (step === 'link') {
    return (
      <div className="flex flex-1 flex-col gap-4 px-5 py-5">
        <p className="text-sm text-v5-fg">Open your conversation with Relay support in this browser?</p>
        <p className="text-xs text-v5-muted">The link from your email works once. This browser will keep access for up to 30 days, until you end the chat here.</p>
        {err ? <p role="alert" className="text-sm font-medium text-[color:var(--v5-warn)]">{friendly(err)}</p> : null}
        <Button disabled={busy || !verifyToken} onClick={() => void run(async () => {
          const r = await wcall<{ open_reference: string | null }>('/api/widget/verify/confirm', { method: 'POST', csrf: info.csrf, body: { token: verifyToken } });
          await refresh(); onDone(r.open_reference);
        })}>{busy ? 'Opening…' : 'Continue'}</Button>
        <Button variant="ghost" onClick={() => onDone(null)}>Not now</Button>
      </div>
    );
  }
  if (step === 'code') {
    return (
      <form className="flex flex-1 flex-col gap-4 px-5 py-5" noValidate onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const fresh = await refresh();
        await wcall('/api/widget/verify/confirm', { method: 'POST', csrf: (fresh ?? info).csrf, body: { code: code.trim() } });
        await refresh(); onDone(null);
      }); }}>
        <p className="text-sm text-v5-fg">If <span className="font-medium">{email}</span> has conversations with us, we’ve emailed it a 6-digit code. It expires in 15 minutes.</p>
        <Field id="wid-code" label="Code" error={fe.code ? friendly(err) : null}>
          <Input id="wid-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            className="tracking-[0.3em]" {...describedBy('wid-code', null, fe.code ? 'x' : null)} />
        </Field>
        {err && !fe.code ? <p role="alert" className="text-sm font-medium text-[color:var(--v5-warn)]">{friendly(err)}</p> : null}
        <Button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify'}</Button>
        <button type="button" className="text-xs font-medium text-v5-primary-text underline-offset-2 hover:underline" onClick={() => onStep('email', email)}>Use a different email or send a new code</button>
      </form>
    );
  }
  return (
    <form className="flex flex-1 flex-col gap-4 px-5 py-5" noValidate onSubmit={(e) => { e.preventDefault(); void run(async () => {
      await wcall('/api/widget/verify', { method: 'POST', csrf: info.csrf, body: { email: email.trim() } });
      await refresh(); onStep('code', email.trim());
    }); }}>
      <p className="text-sm text-v5-fg">Started a conversation on another device? We’ll email a one-time code to the address you used. Typing an email alone never opens a conversation.</p>
      <Field id="wid-verify-email" label="Email" error={fe.email}>
        <Input id="wid-verify-email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} {...describedBy('wid-verify-email', null, fe.email)} />
      </Field>
      {err && !fe.email ? <p role="alert" className="text-sm font-medium text-[color:var(--v5-warn)]">{friendly(err)}</p> : null}
      <Button type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Email me a code'}</Button>
    </form>
  );
}
