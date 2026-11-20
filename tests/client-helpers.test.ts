import { describe, expect, it, vi } from 'vitest';
import { cleanSpokenText, describeMicError, capTranscript, formatCountdown, formatHours, formatRate, ticketQueue, ageLabel, durationLabel, holdLabel, priorityTone, alertProblem, introDue, withTimeout, connectWithFallback, textLink } from '@/lib/client/helpers';
import { MINUTE } from '@/lib/domain/time';
import { NOW } from './helpers';

describe('transcript cleanup', () => {
  it('strips markdown emphasis, headings and list markers', () => {
    expect(cleanSpokenText('**MTG-104** is booked')).toBe('MTG-104 is booked');
    expect(cleanSpokenText('- first\n* second\n1. third')).toBe('first\nsecond\nthird');
    expect(cleanSpokenText('## Policy: _meals_ are `capped`')).toBe('Policy: meals are capped');
    expect(cleanSpokenText('Code NMB_7K2 stays')).toBe('Code NMB_7K2 stays');
    expect(cleanSpokenText('5 * 3 = 15')).toBe('5 * 3 = 15');
  });
});

describe('microphone errors', () => {
  it('explains common failures', () => {
    expect(describeMicError({ name: 'NotAllowedError' })).toMatch(/permission/i);
    expect(describeMicError({ name: 'NotFoundError' })).toMatch(/no microphone/i);
    expect(describeMicError({ name: 'NotReadableError' })).toMatch(/another app/i);
    expect(describeMicError({ code: 'PERMISSION_DENIED' })).toMatch(/permission/i);
    expect(describeMicError(new Error('boom'))).toMatch(/microphone/i);
  });
});

describe('transcript cap and countdown', () => {
  it('keeps only the latest turns', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const { visible, hidden } = capTranscript(items, 200);
    expect(visible).toHaveLength(200);
    expect(visible[0]).toBe(50);
    expect(hidden).toBe(50);
  });
  it('formats mm:ss', () => {
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(61_500)).toBe('01:02');
    expect(formatCountdown(-5)).toBe('00:00');
  });
});

import { mapSignalState } from '@/lib/client/signal';
import { toMessages } from '@/lib/conversation';
import { TurnStatus } from 'agora-agent-client-toolkit';

describe('call state mapping', () => {
  it('prioritises transport problems over agent state', () => {
    expect(mapSignalState('speaking', true, 'RECONNECTING')).toBe('connecting');
    expect(mapSignalState('speaking', true, 'DISCONNECTED')).toBe('error');
    expect(mapSignalState('thinking', true, 'CONNECTED')).toBe('thinking');
    expect(mapSignalState('listening', false, 'CONNECTED')).toBe('connecting');
    expect(mapSignalState('idle', true, 'CONNECTED')).toBe('listening');
  });
  it('maps transcript items to roles and strips markdown', () => {
    const msgs = toMessages(
      [
        { turn_id: 1, uid: '123456', text: '**Nimbus** day.Next', status: TurnStatus.END, _time: 1_700_000_000 } as never,
        { turn_id: 2, uid: '0', text: 'yes please', status: TurnStatus.IN_PROGRESS, _time: 1_700_000_001_000 } as never,
      ],
      '123456',
    );
    expect(msgs[0]).toMatchObject({ role: 'agent', text: 'Nimbus day. Next', createdAt: 1_700_000_000_000, streaming: false });
    expect(msgs[1]).toMatchObject({ role: 'user', streaming: true });
  });
});

import { MIC_TRACK_CONFIG, agentErrorBanner, noSoundSuspected } from '@/lib/client/audio';

describe('audio helpers', () => {
  it('captures the mic with echo cancellation, noise suppression and gain control', () => {
    expect(MIC_TRACK_CONFIG).toEqual({ AEC: true, ANS: true, AGC: true });
  });
  it('suspects missing sound only after 2 s of silent "speaking"', () => {
    expect(noSoundSuspected({ speakingSince: null, lastAudibleAt: 0, now: 10_000 })).toBe(false);
    expect(noSoundSuspected({ speakingSince: 9_000, lastAudibleAt: 0, now: 10_000 })).toBe(false);
    expect(noSoundSuspected({ speakingSince: 7_000, lastAudibleAt: 0, now: 10_000 })).toBe(true);
    expect(noSoundSuspected({ speakingSince: 7_000, lastAudibleAt: 9_500, now: 10_000 })).toBe(false);
  });
  it('only raises a banner for TTS errors', () => {
    expect(agentErrorBanner({ type: 'tts', code: 1001, message: 'vendor timeout' })).toMatch(/voice.*1001.*vendor timeout/i);
    expect(agentErrorBanner({ type: 'llm', code: 1, message: 'x' })).toBeNull();
  });
});

describe('interrupted turns', () => {
  it('flags agent turns that were cut off', () => {
    const [m] = toMessages([{ turn_id: 3, uid: '123456', text: 'Let me check the', status: TurnStatus.INTERRUPTED } as never], '123456');
    expect(m.interrupted).toBe(true);
    expect(toMessages([{ turn_id: 4, uid: '123456', text: 'Done.', status: TurnStatus.END } as never], '123456')[0].interrupted).toBe(false);
  });
});

describe('dashboard numbers', () => {
  it('shows the deflection rate as a percent, or a dash before any outcome', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(2 / 3)).toBe('67%');
    expect(formatRate(1)).toBe('100%');
  });
  it('turns estimated minutes into hours with one decimal', () => {
    expect(formatHours(0)).toBe('0');
    expect(formatHours(90)).toBe('1.5');
    expect(formatHours(120)).toBe('2');
    expect(formatHours(20)).toBe('0.3');
  });
});

describe('ticket queue', () => {
  const t = (number: string, open: boolean, urgency: 1 | 2 | 3, updatedAt: number) => ({ number, open, urgency, updatedAt });
  it('puts open tickets first, most urgent then most recent', () => {
    const queue = ticketQueue([t('A', false, 1, 9), t('B', true, 3, 5), t('C', true, 1, 1), t('D', true, 3, 8), t('E', false, 3, 10)]);
    expect(queue.map((x) => x.number)).toEqual(['C', 'D', 'B', 'E', 'A']);
  });
});

describe('IT desk labels', () => {
  it('shows incident age in the largest whole unit', () => {
    expect(ageLabel(null, NOW)).toBe('—');
    expect(ageLabel(NOW - 30_000, NOW)).toBe('now');
    expect(ageLabel(NOW - 15 * MINUTE, NOW)).toBe('15m');
    expect(ageLabel(NOW - 180 * MINUTE, NOW)).toBe('3h');
    expect(ageLabel(NOW - 2 * 24 * 60 * MINUTE - MINUTE, NOW)).toBe('2d');
  });
  it('shows a time to resolve with one decimal in hours or days', () => {
    expect(durationLabel(45 * MINUTE)).toBe('45m');
    expect(durationLabel(16.2 * 60 * MINUTE)).toBe('16.2h');
    expect(durationLabel(3 * 60 * MINUTE)).toBe('3h');
    expect(durationLabel(77 * 60 * MINUTE)).toBe('3.2d');
  });
  it('names ServiceNow hold reasons', () => {
    expect(holdLabel('4')).toBe('awaiting vendor');
    expect(holdLabel('1')).toBe('awaiting caller');
    expect(holdLabel(null)).toBeNull();
    expect(holdLabel('99')).toBeNull();
  });
  it('colours critical and high priorities', () => {
    expect(priorityTone(1)).toBe('bad');
    expect(priorityTone(2)).toBe('warn');
    expect(priorityTone(3)).toBe('muted');
  });
});

describe('alertProblem', () => {
  const sent = { status: 'sent' as const };
  const failed = (error?: string) => ({ status: 'failed' as const, error });
  it('is null while the newest alert went through', () => {
    expect(alertProblem([])).toBeNull();
    expect(alertProblem([sent, failed('old')])).toBeNull();
    expect(alertProblem([{ status: 'queued' as const }, failed('x')])).toBeNull();
  });
  it('counts the failures since the last success and shows the newest error', () => {
    expect(alertProblem([failed('The Slack bot is not in the channel.'), failed('older'), sent, failed('x')])).toEqual({ error: 'The Slack bot is not in the channel.', failed: 2 });
  });
  it('has a fallback message', () => {
    expect(alertProblem([failed()])).toEqual({ error: 'Slack did not accept the alert.', failed: 1 });
  });
});

describe('introDue', () => {
  const greeting = { id: 'a1', role: 'agent' as const, text: 'Hi', streaming: false, interrupted: false };
  it('is due once the greeting is finished and the engineer is quiet', () => {
    expect(introDue([greeting], 'listening')).toBe(true);
  });
  it('waits while the greeting is still playing or the agent is busy', () => {
    expect(introDue([{ ...greeting, streaming: true }], 'listening')).toBe(false);
    expect(introDue([greeting], 'speaking')).toBe(false);
    expect(introDue([greeting], 'thinking')).toBe(false);
  });
  it('is never due once the engineer has said anything, or before the greeting', () => {
    expect(introDue([greeting, { ...greeting, id: 'u1', role: 'user' as const }], 'listening')).toBe(false);
    expect(introDue([], 'listening')).toBe(false);
    expect(introDue([{ ...greeting, role: 'user' as const }], 'listening')).toBe(false);
  });
});

describe('withTimeout', () => {
  it('passes the result through when it arrives in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, () => new Error('slow'))).resolves.toBe(7);
  });
  it('passes the original error through', async () => {
    await expect(withTimeout(Promise.reject(new Error('denied')), 50, () => new Error('slow'))).rejects.toThrow('denied');
  });
  it('fails with the given error when the step never finishes', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 1000, () => new Error('The microphone permission did not come through.'));
    const check = expect(pending).rejects.toThrow('The microphone permission did not come through.');
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    vi.useRealTimers();
  });
});

describe('connectWithFallback', () => {
  const never = () => new Promise<string>(() => {});
  const late = () => new Error('blocked');
  const timing = { directMs: 100, proxyMs: 200 };

  it('stays direct when the direct attempt connects', async () => {
    const attempt = vi.fn(async (proxy: boolean) => (proxy ? 'proxied' : 'direct'));
    await expect(connectWithFallback(attempt, { ...timing, proxyFirst: false, onLate: late })).resolves.toEqual({ value: 'direct', proxy: false });
    expect(attempt.mock.calls).toEqual([[false]]);
  });
  it('retries through the cloud proxy when the direct attempt is too slow', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn((proxy: boolean) => (proxy ? Promise.resolve('proxied') : never()));
    const out = connectWithFallback(attempt, { ...timing, proxyFirst: false, onLate: late });
    await vi.advanceTimersByTimeAsync(100);
    await expect(out).resolves.toEqual({ value: 'proxied', proxy: true });
    expect(attempt.mock.calls).toEqual([[false], [true]]);
    vi.useRealTimers();
  });
  it('retries through the proxy when the direct attempt fails outright', async () => {
    const attempt = vi.fn((proxy: boolean) => (proxy ? Promise.resolve('proxied') : Promise.reject(new Error('socket closed'))));
    await expect(connectWithFallback(attempt, { ...timing, proxyFirst: false, onLate: late })).resolves.toEqual({ value: 'proxied', proxy: true });
  });
  it('goes straight to the proxy once this browser needed it', async () => {
    const attempt = vi.fn(async () => 'proxied');
    await expect(connectWithFallback(attempt, { ...timing, proxyFirst: true, onLate: late })).resolves.toEqual({ value: 'proxied', proxy: true });
    expect(attempt.mock.calls).toEqual([[true]]);
  });
  it('gives the late error when the proxy is too slow as well, and cleans up each failed attempt', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const out = connectWithFallback(() => never(), { ...timing, proxyFirst: false, onLate: late, onAbandon: cleanup });
    const check = expect(out).rejects.toThrow('blocked');
    await vi.advanceTimersByTimeAsync(300);
    await check;
    expect(cleanup.mock.calls).toEqual([[false], [true]]);
    vi.useRealTimers();
  });
});

describe('textLink', () => {
  it('marks the live text as dropped while it reconnects, and asks for nothing yet', () => {
    expect(textLink(false, 'RECONNECTING')).toEqual({ dropped: true, action: 'none' });
    expect(textLink(false, 'DISCONNECTED')).toEqual({ dropped: true, action: 'none' });
  });
  it('signs in again when the link has failed for good', () => {
    expect(textLink(false, 'FAILED')).toEqual({ dropped: true, action: 'relogin' });
    expect(textLink(true, 'FAILED')).toEqual({ dropped: true, action: 'relogin' });
  });
  it('picks the channel up again once it is back, only after a drop', () => {
    expect(textLink(true, 'CONNECTED')).toEqual({ dropped: false, action: 'resubscribe' });
    expect(textLink(false, 'CONNECTED')).toEqual({ dropped: false, action: 'none' });
  });
  it('keeps the state for anything else', () => {
    expect(textLink(true, 'CONNECTING')).toEqual({ dropped: true, action: 'none' });
    expect(textLink(false, 'CONNECTING')).toEqual({ dropped: false, action: 'none' });
  });
});
