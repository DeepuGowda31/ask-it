'use client';

import { useEffect, useId, useRef } from 'react';
import { Phone, PhoneOff } from 'lucide-react';

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

// A soft two-tone ring every 3 s. Browsers may keep audio blocked until the page is clicked; the ring is then silent but still shown.
function startRing(): () => void {
  const Context = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  let ctx: AudioContext;
  try {
    ctx = new Context();
  } catch {
    return () => {};
  }
  const ring = () => {
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.05, t + 0.08);
    gain.gain.setValueAtTime(0.05, t + 0.9);
    gain.gain.linearRampToValueAtTime(0, t + 1.1);
    gain.connect(ctx.destination);
    for (const hz of [440, 480]) {
      const tone = ctx.createOscillator();
      tone.frequency.value = hz;
      tone.connect(gain);
      tone.start(t);
      tone.stop(t + 1.15);
    }
  };
  ctx.resume().then(ring, () => {});
  const id = setInterval(ring, 3000);
  return () => {
    clearInterval(id);
    ctx.close().catch(() => {});
  };
}

// The follow-up or reminder call: Answer starts a voice call about it, Not now (or Escape) snoozes it.
export function IncomingCall({ number, summary, reminder, onAnswer, onDismiss }: { number: string; summary: string; reminder: boolean; onAnswer: () => void; onDismiss: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const box = useRef<HTMLDivElement>(null);
  const answer = useRef<HTMLButtonElement>(null);
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => startRing(), []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    answer.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss.current();
        return;
      }
      // Focus stays on the two buttons while it rings.
      const buttons = [...(box.current?.querySelectorAll('button') ?? [])];
      if (e.key !== 'Tab' || !buttons.length) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      e.preventDefault();
      buttons[at < 0 ? 0 : next].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  return (
    <>
      <div className="wc-overlay" aria-hidden="true" />
      <div className="wc-incoming-wrap">
        <div ref={box} className="wc-incoming" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
          <span className="wc-incoming-icon" aria-hidden="true"><Phone size={24} /></span>
          <p className="wc-label">Incoming call</p>
          <h2 id={titleId} className="wc-incoming-title">
            {reminder ? <>ASK IT reminder · {summary}{number ? <> · <span className="wc-mono">{number}</span></> : null}</> : <>ASK IT is calling about <span className="wc-mono">{number}</span> · {summary}</>}
          </h2>
          <p id={descriptionId} className="wc-muted">{reminder ? 'You asked ASK IT to check back. Answer to say how it is going.' : 'IT marked it resolved. Answer to say whether it works now.'}</p>
          <div className="wc-incoming-actions">
            <button ref={answer} className="wc-btn wc-btn-primary wc-btn-lg" onClick={onAnswer}>
              <Phone size={18} aria-hidden="true" /> Answer
            </button>
            <button className="wc-btn wc-btn-lg" onClick={onDismiss}>
              <PhoneOff size={18} aria-hidden="true" /> Not now
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
