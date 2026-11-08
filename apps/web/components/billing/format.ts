// Billing display helpers (display only — amounts always come from the server / catalogue, never computed for charging).
import type { Tone } from '@/components/ui';

export const money = (minor: number | null | undefined) => {
  if (minor == null) return '—';
  const v = minor / 100;
  const s = Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${minor < 0 ? '−' : ''}£${s.replace('-', '')}`;
};

export const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export const STATUS_LABEL: Record<string, string> = {
  trialing: 'Free trial', active: 'Active', payment_action_required: 'Action needed', past_due: 'Payment failed', cancel_scheduled: 'Ends at period end',
  cancelled: 'Cancelled', expired: 'Expired', incomplete: 'Payment pending', none: 'No plan', legacy: 'Legacy',
};

export const STATUS_TONE: Record<string, Tone | 'accent'> = {
  trialing: 'accent', active: 'success', payment_action_required: 'danger', past_due: 'danger', cancel_scheduled: 'warn',
  cancelled: 'neutral', expired: 'warn', incomplete: 'warn', none: 'neutral', legacy: 'neutral',
};

export const ACCESS_TONE: Record<string, Tone> = { full: 'success', restricted: 'warn', suspended: 'danger' };

export const seatsLabel = (n: number) => `${n} ${n === 1 ? 'seat' : 'seats'}`;
export const usersLabel = (n: number) => `${n} ${n === 1 ? 'user' : 'users'}`;
