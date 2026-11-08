'use client';
// Translation in the inbox: the latest customer message (original stays visible) and a reply draft whose EXACT outgoing
// translation is shown for review. Nothing is sent or replaced: "Copy" hands the text to the agent, who sends it with
// the normal reply composer. Renders nothing unless the workspace has translation on.
import { useState } from 'react';
import { Copy, Languages } from 'lucide-react';
import type { TranslationJson, TranslationSettingsJson } from '@social-lite/core/contracts/v35-integrations';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Field, Select, SimulatedBadge, Textarea, useToast } from '@/components/ui';

const LANGS: Array<[string, string]> = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ar', 'Arabic'], ['ja', 'Japanese']];

export function TranslatePanel({ conversationId, latestInboundId, customerLanguage }: { conversationId: string; latestInboundId: string | null; customerLanguage: string | null }) {
  const toast = useToast();
  const s = useApi<TranslationSettingsJson>('/api/connectors/translate/settings');
  const mine = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2);
  const [toMe, setToMe] = useState(LANGS.some(([c]) => c === mine) ? mine : 'en');
  const [toCustomer, setToCustomer] = useState(customerLanguage && LANGS.some(([c]) => c === customerLanguage) ? customerLanguage : 'es');
  const [incoming, setIncoming] = useState<TranslationJson | null>(null);
  const [draft, setDraft] = useState('');
  const [outgoing, setOutgoing] = useState<TranslationJson | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!s.data?.enabled) return null;
  const customerAllowed = s.data.allow_customer_content;
  const run = async (k: string, fn: () => Promise<void>) => { setBusy(k); try { await fn(); } catch (e) { toast.error(e); } finally { setBusy(null); } };
  return (
    <section aria-labelledby={`tr-${conversationId}`} data-testid="translate-panel">
      <h3 id={`tr-${conversationId}`} className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle"><Languages aria-hidden className="size-3.5" />Translate</h3>
      {!customerAllowed ? <p className="text-xs text-muted">Customer messages are not sent for translation in this workspace.</p> : (
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <Field label="Into" className="w-32"><Select value={toMe} onChange={(e) => { setToMe(e.target.value); setIncoming(null); }}>{LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>
            <Button size="sm" variant="secondary" loading={busy === 'in'} disabledReason={!latestInboundId ? 'No customer message' : null}
              onClick={() => run('in', async () => setIncoming(await api.post<TranslationJson>('/api/connectors/translate', { source_type: 'inbox_message', source_id: latestInboundId, target_lang: toMe })))}>Latest message</Button>
          </div>
          {incoming ? <Result t={incoming} /> : null}
          <Field label="Your reply (your language)"><Textarea rows={3} value={draft} maxLength={5000} onChange={(e) => { setDraft(e.target.value); setOutgoing(null); }} /></Field>
          <div className="flex items-end gap-2">
            <Field label="Customer’s language" className="w-36"><Select value={toCustomer} onChange={(e) => { setToCustomer(e.target.value); setOutgoing(null); }}>{LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>
            <Button size="sm" variant="secondary" loading={busy === 'out'} disabledReason={!draft.trim() ? 'Write the reply first' : null}
              onClick={() => run('out', async () => setOutgoing(await api.post<TranslationJson>('/api/connectors/translate', { source_type: 'reply_draft', source_id: conversationId, text: draft.trim(), target_lang: toCustomer })))}>Translate reply</Button>
          </div>
          {outgoing ? (
            <div className="flex flex-col gap-2">
              <Result t={outgoing} outgoing />
              <Button size="sm" variant="ghost" icon={<Copy aria-hidden className="size-4" />} onClick={() => { void navigator.clipboard?.writeText(outgoing.translated_text); toast.success('Copied. Review it in the reply box before sending.'); }}>Copy to use in reply</Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function Result({ t, outgoing }: { t: TranslationJson; outgoing?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-sunken p-2.5 text-[13px]" data-testid={outgoing ? 'translation-outgoing' : 'translation-incoming'}>
      <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Badge tone="info">Machine translated</Badge>{t.source_lang ?? '?'} → {t.target_lang}{t.detected ? ' (detected)' : ''}{t.is_simulated ? <SimulatedBadge /> : null}
      </p>
      <p className="whitespace-pre-wrap break-words">{t.translated_text}</p>
      <details className="mt-1 text-xs text-muted"><summary className="cursor-pointer">Original</summary><p className="mt-1 whitespace-pre-wrap break-words">{t.original_text}</p></details>
      {outgoing ? <p className="mt-1 text-xs text-warn">This exact text is what the customer would get. Check it before sending.</p> : null}
    </div>
  );
}
