'use client';
// Sign-in link that returns the reader to the help page they were on.
import { usePathname } from 'next/navigation';
import { LogIn } from 'lucide-react';
import { LinkButton } from '@/components/ui';

export function SignInLink({ label = 'Sign in', variant = 'secondary' }: { label?: string; variant?: 'primary' | 'secondary' }) {
  const path = usePathname() || '/help';
  return <LinkButton href={`/login?returnTo=${encodeURIComponent(path)}`} variant={variant} size="sm" icon={<LogIn aria-hidden className="size-4" />}>{label}</LinkButton>;
}
