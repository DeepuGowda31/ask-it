'use client';

import { useCallback, useEffect, useState } from 'react';
import { SNOOZE_MS, isRinging, ringId } from '@/lib/domain/followup';
import type { FollowUp } from '@/lib/domain/types';

const POLL_MS = 20_000;

// While the line is free, asks the server every 20 s to look for tickets IT resolved and due reminders; the ring itself comes with the session view.
export function useFollowUp(code: string | null, followUp: FollowUp | null, lineFree: boolean, now: number) {
  // "Not now" hides the ring at once, even before or without the server's answer.
  const [snoozed, setSnoozed] = useState<{ id: string; until: number } | null>(null);

  useEffect(() => {
    if (!code || !lineFree) return;
    const check = () => fetch(`/api/followup?session=${encodeURIComponent(code)}`, { cache: 'no-store' }).catch(() => {});
    check();
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [code, lineFree]);

  const id = followUp ? ringId(followUp) : null;
  const snooze = useCallback(() => {
    if (!code || !id) return;
    setSnoozed({ id, until: Date.now() + SNOOZE_MS });
    fetch('/api/followup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: code, number: id, action: 'snooze' }),
    }).catch(() => {});
  }, [code, id]);

  const hidden = snoozed !== null && snoozed.id === id && now < snoozed.until;
  return { ringing: lineFree && !hidden && isRinging(followUp, now) ? followUp : null, snooze };
}
