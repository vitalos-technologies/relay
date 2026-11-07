'use client';
import { useEffect } from 'react';
import { apiFetch } from '@/lib/client/api';

/** Guests (only guest grants) belong in the review portal; the main app shows them nothing anyway (server-enforced). */
export function GuestRedirect() {
  useEffect(() => {
    let live = true;
    apiFetch<{ guest_only: boolean }>('/api/review/me', { redirectOn401: false })
      .then((r) => { if (live && r.guest_only && !window.location.pathname.startsWith('/review')) window.location.replace('/review'); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return null;
}
