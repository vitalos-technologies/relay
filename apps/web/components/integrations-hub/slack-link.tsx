'use client';
// Confirms "this Slack account is me" for the signed-in Relay person. The token came from a verified Slack request and
// is bound to that Slack user; nothing is matched by name or email.
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Hash } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Banner, Button, Card, CardHeader, FeatureTile, LinkButton } from '@/components/ui';

export function SlackLinkPage() {
  const t = useSearchParams().get('t') ?? '';
  const { session } = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | { error: string }>('idle');
  return (
    <Card className="max-w-lg" aria-labelledby="h-sl">
      <CardHeader id="h-sl" title={<span className="inline-flex items-center gap-3"><FeatureTile size="sm"><Hash /></FeatureTile>Link your Slack account</span>} />
      <div className="flex flex-col gap-4 px-4 pb-4">
        {state === 'done' ? (
          <Banner tone="success" title="Linked">Go back to Slack and press the button again.</Banner>
        ) : (
          <>
            <p className="text-[13px] text-muted">Slack buttons will act as <strong className="text-fg">{session.user.name ?? session.user.email}</strong> with your current Relay permissions.</p>
            {typeof state === 'object' ? <Banner tone="danger" title="Not linked">{state.error}</Banner> : null}
            <div className="flex gap-2">
              <Button variant="primary" loading={state === 'busy'} disabledReason={!t ? 'This link is incomplete' : null}
                onClick={async () => { setState('busy'); try { await api.post('/api/connectors/slack/link', { token: t }); setState('done'); } catch (e) { setState({ error: e instanceof Error ? e.message : 'Try again from Slack.' }); } }}>Link</Button>
              <LinkButton href="/integrations/slack" variant="ghost">Cancel</LinkButton>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
