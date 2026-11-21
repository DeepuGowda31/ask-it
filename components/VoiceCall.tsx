'use client';

import dynamic from 'next/dynamic';
import { Suspense, useRef, type ReactNode } from 'react';
import { Loader2, Mic, MicOff, PhoneOff } from 'lucide-react';
import { AgentSignal } from './AgentSignal';
import { BrandMark, type Mark } from './Brand';
import { ErrorBoundary } from './ErrorBoundary';
import type { VoiceCall } from '@/lib/client/useVoiceCall';

const CallSession = dynamic(() => import('./CallSession'), { ssr: false });

// RTC provider is browser-only; one client per call, kept in a ref (StrictMode safe).
const AgoraProvider = dynamic(
  async () => {
    const { AgoraRTCProvider, default: AgoraRTC } = await import('agora-rtc-react');
    return {
      default: function Provider({ proxy, children }: { proxy: boolean; children: ReactNode }) {
        const ref = useRef<ReturnType<typeof AgoraRTC.createClient> | null>(null);
        if (!ref.current) {
          ref.current = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
          // Force TCP cloud proxy over TLS 443, set before joining.
          if (proxy) ref.current.startProxyServer(5);
        }
        return <AgoraRTCProvider client={ref.current}>{children}</AgoraRTCProvider>;
      },
    };
  },
  { ssr: false },
);

// Mounts the call while it is live; unmounting ends it.
export function CallMount({ call }: { call: VoiceCall }) {
  if (call.phase !== 'live' || !call.agoraData || !call.rtmClient) return null;
  return (
    <Suspense fallback={null}>
      <ErrorBoundary onError={() => call.endCall('client error', 'The call view crashed. Please start a new call.')}>
        <AgoraProvider proxy={call.agoraData.proxy === true}>
          <CallSession agoraData={call.agoraData} rtmClient={call.rtmClient} micEnabled={call.micEnabled} onTokenWillExpire={call.handleTokenWillExpire} callbacks={call.callbacks} />
        </AgoraProvider>
      </ErrorBoundary>
    </Suspense>
  );
}

export function CallSignal({ call }: { call: VoiceCall }) {
  const inCall = call.phase !== 'idle';
  return (
    <section className="wc-signal" aria-label="Call activity">
      <AgentSignal activity={{ state: call.signalState, micEnabled: call.micEnabled, levelSource: call.levelSource }} paused={false} />
      <div className="wc-signal-caption" role="status" aria-live="polite">
        <h2>{inCall ? call.caption : ''}</h2>
        {inCall && call.captionDetail ? <p>{call.captionDetail}</p> : null}
      </div>
    </section>
  );
}

// The agent's own sticker in place of the signal: its ring follows the call, speaking, listening or thinking.
export function AgentSticker({ call, mark }: { call: VoiceCall; mark: Mark }) {
  return (
    <section className="wc-sticker" data-state={call.signalState} aria-label="Call activity">
      <span className="wc-sticker-ring" aria-hidden="true"><BrandMark mark={mark} className="wc-sticker-mark" /></span>
      <p className="wc-sticker-caption" role="status" aria-live="polite">{call.phase === 'idle' ? '' : call.caption}</p>
    </section>
  );
}

export function CallBanners({ call }: { call: VoiceCall }) {
  const live = call.phase === 'live';
  return (
    <div className="wc-banners">
      {call.voiceError && live ? <p className="wc-notice wc-notice-bad" role="alert">{call.voiceError}</p> : null}
      {call.resumeAudio && live ? (
        <div className="wc-notice wc-notice-warn" role="alert">
          <span>Your browser paused the ASK IT audio.</span>
          <button className="wc-btn" onClick={() => call.resumeAudio?.()}>Enable sound</button>
        </div>
      ) : null}
      {call.textPaused && live ? <p className="wc-notice wc-notice-warn" role="status">Live text reconnecting. Your call continues.</p> : null}
      {call.issues.length ? <p className="wc-notice wc-notice-warn" role="alert">{call.issues[0]}</p> : null}
      {call.phase === 'ended' && call.error ? <p className="wc-notice wc-notice-bad" role="alert">{call.error}</p> : null}
      {call.noSound && live && !call.resumeAudio ? <p className="wc-notice" role="status">No sound? Check your output device and volume.</p> : null}
    </div>
  );
}

export function CallDock({ call, endedText, onRestart }: { call: VoiceCall; endedText: string; onRestart: () => void }) {
  if (call.phase === 'ended') {
    return (
      <div className="wc-dock" role="group" aria-label="Call controls">
        <span className="wc-muted text-[13px]">{endedText}</span>
        <button className="wc-btn wc-btn-primary" onClick={onRestart}><Mic size={16} aria-hidden="true" /> New call</button>
      </div>
    );
  }
  return (
    <div className="wc-dock" role="group" aria-label="Call controls">
      <span className="flex items-center gap-3">
        <button
          className="wc-btn wc-icon-btn"
          onClick={() => call.setMicEnabled((v) => !v)}
          disabled={call.phase !== 'live'}
          aria-pressed={!call.micEnabled}
          aria-label={call.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {call.micEnabled ? <Mic size={18} /> : <MicOff size={18} className="wc-tone-bad" />}
        </button>
        <span className="wc-muted hidden text-[13px] sm:inline">
          {call.phase === 'connecting' ? 'Starting ASK IT…' : call.micEnabled ? 'Just talk. No buttons needed.' : 'Microphone muted'}
        </span>
      </span>
      <button className="wc-btn wc-btn-danger" onClick={() => call.endCall('user ended')} disabled={call.phase !== 'live'} aria-label="End call">
        {call.phase === 'connecting' ? <Loader2 size={16} className="wc-spin" aria-hidden="true" /> : <PhoneOff size={16} aria-hidden="true" />}
        End
      </button>
    </div>
  );
}
