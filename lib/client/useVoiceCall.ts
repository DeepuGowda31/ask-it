'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RTMClient } from 'agora-rtm';
import type { AgentEvent, CallCallbacks } from '@/components/CallSession';
import type { TranscriptMessage } from '@/lib/conversation';
import { describeMicError, withTimeout } from './helpers';
import { agentErrorBanner, noSoundSuspected } from './audio';
import { SIGNAL_CAPTION, mapSignalState, type AudioLevelSource, type SignalState } from './signal';
import type { CallProbe } from './diagnostics';
import type { AgentResponse, AgoraRenewalTokens, AgoraTokenData, ClientStartRequest } from '@/types/conversation';

type Phase = 'idle' | 'connecting' | 'live' | 'ended';
// How long each call step may take before the call stops with a message instead of staying on "Connecting".
const MIC_WAIT_MS = 20_000;
const STEP_WAIT_MS = 15_000;
const AGENT_WAIT_MS = 20_000;
const MIC_LATE = 'The microphone permission did not come through. Allow the microphone for this site (lock icon in the address bar), then try again.';
const RTM_LATE = "Could not reach the live voice service. This network may be blocking it: try Wi-Fi or another network, then try again.";
type Persona = NonNullable<ClientStartRequest['persona']>;

class UserFacingError extends Error {}

// One voice call on a session: start, end, transcript, levels and the status lines around it.
export function useVoiceCall({ code, persona, now, recentAction, thinkingHint }: { code: string | null; persona: Persona; now: number; recentAction: string | null; thinkingHint: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const [error, setError] = useState<string | null>(null);
  const [canTakeOver, setCanTakeOver] = useState(false);
  const [agoraData, setAgoraData] = useState<AgoraTokenData | null>(null);
  const [rtmClient, setRtmClient] = useState<RTMClient | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [agentState, setAgentState] = useState<string | null>(null);
  const [connection, setConnection] = useState('CONNECTING');
  const [agentIn, setAgentIn] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [micEnabled, setMicEnabled] = useState(true);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [resumeAudio, setResumeAudio] = useState<(() => void) | null>(null);
  const [noSound, setNoSound] = useState(false);
  const [levels, setLevels] = useState<{ local: AudioLevelSource | null; remote: AudioLevelSource | null }>({ local: null, remote: null });
  const probe = useRef<CallProbe | null>(null);
  const busy = useRef(false);
  const agentIdRef = useRef<string | null>(null);
  const agentSeen = useRef(false);

  const endCall = useCallback(
    (reason: string, message?: string) => {
      if (phaseRef.current !== 'live') return;
      phaseRef.current = 'ended';
      setPhase('ended'); // unmounting CallSession leaves the channel and releases the microphone
      setDeadline(null);
      if (message) setError(message);
      const agentId = agentIdRef.current;
      agentIdRef.current = null;
      fetch('/api/stop-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session: code, reason }),
        keepalive: true,
      }).catch(() => {});
      setRtmClient((rtm) => {
        rtm?.logout().catch(() => {});
        return null;
      });
    },
    [code],
  );

  const startCall = useCallback(
    async (takeover = false, followUp?: string) => {
      if (busy.current || !code) return; // double-click guard: one call per tab
      busy.current = true;
      setPhase('connecting');
      setError(null);
      setCanTakeOver(false);
      setTranscript([]);
      setIssues([]);
      setAgentEvents([]);
      setVoiceError(null);
      setResumeAudio(null);
      setNoSound(false);
      setAgentState(null);
      setAgentIn(false);
      setMicEnabled(true);
      setConnection('CONNECTING');
      agentSeen.current = false;
      let rtm: RTMClient | null = null;
      try {
        if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
          throw new UserFacingError('This browser cannot make voice calls. Use a recent Chrome, Edge, Safari or Firefox over HTTPS.');
        }
        try {
          const probe = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), MIC_WAIT_MS, () => new UserFacingError(MIC_LATE));
          probe.getTracks().forEach((t) => t.stop());
        } catch (e) {
          throw e instanceof UserFacingError ? e : new UserFacingError(describeMicError(e));
        }

        const tokenRes = await withTimeout(fetch('/api/generate-agora-token'), STEP_WAIT_MS, () => new UserFacingError('Getting a call token took too long. Check your connection and try again.')).catch(() => null);
        const token = tokenRes ? await tokenRes.json().catch(() => ({})) : {};
        if (!tokenRes?.ok) throw new UserFacingError(`Could not get a call token${token.error ? `: ${token.error}` : '. Check your connection.'}`);

        const { default: AgoraRTM } = await import('agora-rtm');
        rtm = new AgoraRTM.RTM(process.env.NEXT_PUBLIC_AGORA_APP_ID!, token.uid);
        const start: ClientStartRequest = { requester_id: token.uid, channel_name: token.channel, session: code, takeover, persona, ...(followUp ? { followUp } : {}) };
        const [invite, rtmReady] = await Promise.allSettled([
          withTimeout(
            fetch('/api/invite-agent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(start),
            }).then(async (res) => ({ res, body: await res.json().catch(() => ({})) })),
            AGENT_WAIT_MS,
            () => new UserFacingError('ASK IT took too long to start. Please try again.'),
          ),
          withTimeout(
            (async () => {
              await rtm!.login({ token: token.token });
              await rtm!.subscribe(token.channel);
            })(),
            STEP_WAIT_MS,
            () => new UserFacingError(RTM_LATE),
          ),
        ]);
        if (invite.status === 'rejected') {
          throw invite.reason instanceof UserFacingError ? invite.reason : new UserFacingError('Could not reach the server to start ASK IT. Check your connection.');
        }
        const { res, body } = invite.value;
        if (!res.ok) {
          if (res.status === 409) setCanTakeOver(true);
          throw new UserFacingError(body.error ?? `ASK IT could not start (HTTP ${res.status}).`);
        }
        const agent = body as AgentResponse;
        if (rtmReady.status === 'rejected') {
          fetch('/api/stop-conversation', { method: 'POST', body: JSON.stringify({ agent_id: agent.agent_id, session: code, reason: 'messaging failed' }) }).catch(() => {});
          throw rtmReady.reason instanceof UserFacingError ? rtmReady.reason : new UserFacingError('Could not connect the live transcript channel. Please try again.');
        }
        agentIdRef.current = agent.agent_id;
        setRtmClient(rtm);
        setAgoraData({ ...token, agentId: agent.agent_id });
        setDeadline(Date.now() + (agent.max_seconds ?? 600) * 1000);
        phaseRef.current = 'live';
        setPhase('live');
      } catch (e) {
        rtm?.logout().catch(() => {});
        setPhase('idle');
        setError(e instanceof UserFacingError ? e.message : 'Something went wrong starting the call. Please try again.');
      } finally {
        busy.current = false;
      }
    },
    [code, persona],
  );

  // Hard 10-minute cap, like the official demos.
  useEffect(() => {
    if (phase === 'live' && deadline && now >= deadline) endCall('time limit', 'The session reached its 10 minute limit. Start a new call to continue.');
  }, [now, deadline, phase, endCall]);

  // Closing the tab must not leave an agent running.
  useEffect(() => {
    const onHide = () => {
      if (phaseRef.current !== 'live' || !agentIdRef.current) return;
      navigator.sendBeacon?.('/api/stop-conversation', JSON.stringify({ agent_id: agentIdRef.current, session: code, reason: 'tab closed' }));
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [code]);

  const callbacks = useMemo<CallCallbacks>(
    () => ({
      onTranscript: setTranscript,
      onAgentState: setAgentState,
      onConnection: (state, reason) => {
        setConnection(state);
        if (state === 'DISCONNECTED' && reason && reason !== 'LEAVE') {
          endCall('connection lost', 'The connection dropped and could not recover. Check your network and start a new call.');
        }
      },
      onAgentPresence: (present) => {
        setAgentIn(present);
        if (present) agentSeen.current = true;
        else if (agentSeen.current) endCall('agent left', 'ASK IT left the call (it was idle or its session ended).');
      },
      onLevels: setLevels,
      onAgentEvent: (event) => {
        setAgentEvents((prev) => [event, ...prev].slice(0, 100));
        if (event.kind === 'error') {
          const banner = agentErrorBanner({ type: event.module ?? '', code: event.code ?? 0, message: event.message });
          if (banner) setVoiceError(banner);
        }
      },
      onAudioBlocked: (resume) => setResumeAudio(() => resume),
      onIssue: (message) => setIssues((prev) => (prev.includes(message) ? prev : [message, ...prev].slice(0, 5))),
      onProbe: (p) => {
        probe.current = p;
      },
    }),
    [endCall],
  );

  // "No sound?" hint: the agent says it is speaking but its audio track stays silent for > 2 s.
  const speakingSince = useRef<number | null>(null);
  const lastAudible = useRef(0);
  useEffect(() => {
    speakingSince.current = phase === 'live' && agentState === 'speaking' ? Date.now() : null;
    if (speakingSince.current === null) setNoSound(false);
  }, [agentState, phase]);
  useEffect(() => {
    if (phase !== 'live') return;
    const id = setInterval(() => {
      const t = Date.now();
      try {
        if ((levels.remote?.getVolumeLevel() ?? 0) > 0.02) lastAudible.current = t;
      } catch {
        // track went away
      }
      setNoSound(noSoundSuspected({ speakingSince: speakingSince.current, lastAudibleAt: lastAudible.current, now: t }));
    }, 250);
    return () => clearInterval(id);
  }, [phase, levels.remote]);

  const handleTokenWillExpire = useCallback(
    async (uid: string): Promise<AgoraRenewalTokens> => {
      const channel = agoraData?.channel;
      const [rtc, rtmTok] = await Promise.all([
        fetch(`/api/generate-agora-token?channel=${channel}&uid=${uid}`).then((r) => r.json()),
        fetch(`/api/generate-agora-token?channel=${channel}&uid=${agoraData?.uid}`).then((r) => r.json()),
      ]);
      return { rtcToken: rtc.token, rtmToken: rtmTok.token };
    },
    [agoraData],
  );

  const reset = useCallback(() => {
    setPhase('idle');
    setTranscript([]);
  }, []);

  const signalState: SignalState =
    phase === 'idle' ? 'idle' : phase === 'connecting' ? 'connecting' : phase === 'ended' ? 'ended' : mapSignalState(agentState, agentIn, connection);
  const levelSource = signalState === 'speaking' ? levels.remote : signalState === 'listening' && micEnabled ? levels.local : null;
  const caption = !micEnabled && phase === 'live' ? 'Microphone muted' : SIGNAL_CAPTION[signalState];
  const captionDetail =
    signalState === 'thinking'
      ? recentAction ?? thinkingHint
      : signalState === 'speaking'
        ? 'Speak any time to interrupt.'
        : signalState === 'connecting' && phase === 'live'
          ? connection === 'RECONNECTING' ? 'Reconnecting to the call…' : 'Waiting for ASK IT to join…'
          : !micEnabled && phase === 'live' ? 'Unmute when you are ready to speak.' : '';

  const status = (() => {
    if (phase === 'connecting') return { label: 'Connecting', tone: 'info' };
    if (phase === 'ended') return { label: 'Ended', tone: 'muted' };
    if (connection === 'RECONNECTING') return { label: 'Reconnecting', tone: 'warn' };
    if (connection === 'DISCONNECTED') return { label: 'Error', tone: 'bad' };
    if (!agentIn) return { label: 'Connecting', tone: 'info' };
    return { label: 'Connected', tone: 'ok' };
  })();

  return {
    phase,
    phaseRef,
    error,
    canTakeOver,
    agoraData,
    rtmClient,
    deadline,
    transcript,
    issues,
    micEnabled,
    setMicEnabled,
    agentEvents,
    voiceError,
    resumeAudio,
    noSound,
    callbacks,
    probe,
    handleTokenWillExpire,
    signalState,
    levelSource,
    caption,
    captionDetail,
    status,
    startCall,
    endCall,
    reset,
  };
}

export type VoiceCall = ReturnType<typeof useVoiceCall>;
