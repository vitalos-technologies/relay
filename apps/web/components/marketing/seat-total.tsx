'use client';
// Seat estimate on the signup handoff (/signup?plan=…&seats=…): number of users and the monthly total after the trial,
// from the shared catalogue functions. Display only — checkout charges for the workspace's billable users at that time and
// Settings → Billing shows the exact seats and total again before anything is bought.
import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { formatMinorGBP, recurringTotalMinor, type PublicPlanId } from '@social-lite/core/contracts/v4-plans';

export function SeatTotal({ plan, planName, initialSeats, trialDays }: { plan: PublicPlanId; planName: string; initialSeats: number; trialDays: number }) {
  const [seats, setSeats] = useState(initialSeats);
  const set = (n: number) => setSeats(Math.max(1, Math.min(500, Math.round(Number.isFinite(n) ? n : 1))));
  const btn = 'touch-target inline-flex size-9 items-center justify-center rounded-lg border border-border hover:bg-raised disabled:opacity-40';
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-border bg-surface p-4" data-testid="signup-seats">
      <label htmlFor="signup-seats" className="text-sm font-medium">Team size</label>
      <div className="flex items-center gap-1.5">
        <button type="button" className={btn} onClick={() => set(seats - 1)} disabled={seats <= 1} aria-label="One user fewer"><Minus aria-hidden className="size-4" /></button>
        <input id="signup-seats" type="number" inputMode="numeric" min={1} max={500} value={seats} onChange={(e) => set(Number(e.target.value))}
          className="h-9 w-16 rounded-lg border border-border bg-sunken text-center text-sm font-semibold tabular" />
        <button type="button" className={btn} onClick={() => set(seats + 1)} disabled={seats >= 500} aria-label="One user more"><Plus aria-hidden className="size-4" /></button>
      </div>
      <p className="text-sm" aria-live="polite" data-testid="signup-total">
        <span className="font-semibold tabular">{seats} {seats === 1 ? 'user' : 'users'} × {formatMinorGBP(recurringTotalMinor(plan, 1))} = {formatMinorGBP(recurringTotalMinor(plan, seats))} / month</span>
        <span className="text-muted"> on {planName}, after the {trialDays}-day trial</span>
      </p>
    </div>
  );
}
