'use client';
// V2: people, teams, invitations and access live on /team (scoped grants, teams, effective access).
import { ArrowRight, Users } from 'lucide-react';
import { EmptyState, LinkButton } from '@/components/ui';

export function TeamTab() {
  return (
    <EmptyState icon={<Users aria-hidden />} title="Members, teams and access moved to Team"
      action={<LinkButton href="/team" variant="secondary" icon={<ArrowRight aria-hidden className="size-4" />}>Open Team</LinkButton>} />
  );
}
