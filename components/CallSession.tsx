'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AgoraRTC, {
  useClientEvent,
  useJoin,
  useLocalMicrophoneTrack,
  usePublish,
  useRemoteAudioTracks,
  useRemoteUsers,
  useRTCClient,
} from 'agora-rtc-react';
import type { IRemoteAudioTrack } from 'agora-rtc-react';
import { AgoraVoiceAI, AgoraVoiceAIEvents, TranscriptHelperMode } from 'agora-agent-client-toolkit';
import type { RTMClient } from 'agora-rtm';
import { DEFAULT_AGENT_UID } from '@/lib/agora';
import { toMessages, type TranscriptMessage } from '@/lib/conversation';
import { describeMicError } from '@/lib/client/helpers';
import { MIC_TRACK_CONFIG } from '@/lib/client/audio';
import type { AudioLevelSource } from '@/lib/client/signal';
import type { CallProbe } from '@/lib/client/diagnostics';
import type { AgoraRenewalTokens, AgoraTokenData } from '@/types/conversation';

export interface CallCallbacks {
  onTranscript: (messages: TranscriptMessage[]) => void;
  onAgentState: (state: string | null) => void;
  onConnection: (state: string, reason?: string) => void;
  onAgentPresence: (inChannel: boolean) => void;
  onLevels: (levels: { local: AudioLevelSource | null; remote: AudioLevelSource | null }) => void;
  onIssue: (message: string) => void;
  /** Raw agent-side events received over RTM, for the Inspector and error banners. */
  onAgentEvent: (event: AgentEvent) => void;
  /** Browser blocked or suspended audio output; call `resume` from a user gesture. */
  onAudioBlocked: (resume: (() => void) | null) => void;
  /** Live call stats for the laptop check; null once the call is gone. */
  onProbe: (probe: CallProbe | null) => void;
}

export interface AgentEvent {
  at: number;
  kind: 'error' | 'interrupted' | 'metric' | 'turn';
  module?: string;
  code?: number;
  message: string;
}

type AgoraRtcWithParameters = typeof AgoraRTC & { setParameter?: (key: string, value: unknown) => void };

const AGENT_UID = String(DEFAULT_AGENT_UID);

/**
 * Owns the RTC join, microphone publish and the AgoraVoiceAI (RTM) subscription.
 * Renders nothing: it plays the agent's audio and reports state; the parent renders the UI.
 * Unmounting this component is how a call ends: the Agora hooks leave the channel and close the mic.
 */
export default function CallSession({
  agoraData,
  rtmClient,
  micEnabled,
  onTokenWillExpire,
  callbacks,
}: {
  agoraData: AgoraTokenData;
  rtmClient: RTMClient;
  micEnabled: boolean;
  onTokenWillExpire: (uid: string) => Promise<AgoraRenewalTokens>;
  callbacks: CallCallbacks;
}) {
  const client = useRTCClient();
  const remoteUsers = useRemoteUsers();
  const cb = useRef(callbacks);
  cb.current = callbacks;

  // StrictMode guard (from the official quickstart): only the real mount joins and opens the mic.
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => !cancelled && setIsReady(true), 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
      setIsReady(false);
    };
  }, []);

  const { isConnected: joined } = useJoin(
    { appid: process.env.NEXT_PUBLIC_AGORA_APP_ID!, channel: agoraData.channel, token: agoraData.token, uid: parseInt(agoraData.uid, 10) },
    isReady,
  );
  const { localMicrophoneTrack, error: micError } = useLocalMicrophoneTrack(isReady, MIC_TRACK_CONFIG);
  usePublish([localMicrophoneTrack]);

  useEffect(() => {
    if (micError) cb.current.onIssue(describeMicError(micError));
  }, [micError]);

  // Mute with setEnabled only; usePublish owns publishing.
  useEffect(() => {
    localMicrophoneTrack?.setEnabled(micEnabled).catch(() => {});
  }, [micEnabled, localMicrophoneTrack]);

  useEffect(() => {
    try {
      (AgoraRTC as AgoraRtcWithParameters).setParameter?.('ENABLE_AUDIO_PTS', true);
    } catch {
      /* optional SDK parameter */
    }
  }, []);

  // Transcript + agent state via RTM, initialised once after join.
  useEffect(() => {
    if (!isReady || !joined) return;
    let cancelled = false;
    (async () => {
      try {
        const ai = await AgoraVoiceAI.init({ rtcEngine: client, rtmEngine: rtmClient, renderMode: TranscriptHelperMode.TEXT, enableLog: false });
        if (cancelled) {
          if (AgoraVoiceAI.getInstance() === ai) {
            ai.unsubscribe();
            ai.destroy();
          }
          return;
        }
        ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (t) => cb.current.onTranscript(toMessages([...t], AGENT_UID)));
        ai.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_, event) => cb.current.onAgentState(event.state));
        const emit = (e: Omit<AgentEvent, 'at'>) => cb.current.onAgentEvent({ at: Date.now(), ...e });
        ai.on(AgoraVoiceAIEvents.AGENT_ERROR, (_, error) =>
          emit({ kind: 'error', module: error.type, code: error.code, message: error.message }),
        );
        ai.on(AgoraVoiceAIEvents.MESSAGE_ERROR, (_, error) =>
          emit({ kind: 'error', module: `message:${error.type}`, code: error.code, message: error.message }),
        );
        ai.on(AgoraVoiceAIEvents.AGENT_INTERRUPTED, (_, event) => emit({ kind: 'interrupted', message: `Agent interrupted (turn ${event.turnID})` }));
        ai.on(AgoraVoiceAIEvents.AGENT_METRICS, (_, m) => emit({ kind: 'metric', module: m.type, message: `${m.name}: ${Math.round(m.value)} ms` }));
        ai.on(AgoraVoiceAIEvents.AGENT_TURN_FINISHED, (_, turn) =>
          emit({ kind: 'turn', message: `Turn ${turn.turnId} finished, end-to-end ${Math.round(turn.e2eLatencyMs)} ms ${JSON.stringify(turn.segmentedLatency)}` }),
        );
        ai.subscribeMessage(agoraData.channel);
      } catch (error) {
        if (!cancelled) cb.current.onIssue(`Live transcript unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    })();
    return () => {
      cancelled = true;
      try {
        const ai = AgoraVoiceAI.getInstance();
        ai?.unsubscribe();
        ai?.destroy();
      } catch {
        /* already torn down */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, joined]);

  useClientEvent(client, 'connection-state-change', (state, _prev, reason) => cb.current.onConnection(state, reason));

  const agent = remoteUsers.find((u) => String(u.uid) === AGENT_UID);
  useEffect(() => {
    cb.current.onAgentPresence(Boolean(agent));
  }, [agent]);

  // Play the agent's audio explicitly: subscribe via the hook, start each track once (never
  // stop/replay on re-render), and stop on unmount.
  const agentUsers = useMemo(() => (agent ? [agent] : []), [agent]);
  const { audioTracks } = useRemoteAudioTracks(agentUsers);
  const playing = useRef<IRemoteAudioTrack[]>([]);
  useEffect(() => {
    for (const track of audioTracks) {
      if (!track.isPlaying) track.play();
    }
    playing.current = audioTracks;
  }, [audioTracks]);
  useEffect(() => () => playing.current.forEach((t) => t.stop()), []);

  // Autoplay blocked or AudioContext suspended/interrupted: let the user resume with a tap.
  useEffect(() => {
    const resume = () => {
      AgoraRTC.resumeAudioContext();
      playing.current.forEach((t) => !t.isPlaying && t.play());
      cb.current.onAudioBlocked(null);
    };
    AgoraRTC.onAutoplayFailed = () => cb.current.onAudioBlocked(resume);
    const onContext = (state: string) => cb.current.onAudioBlocked(state === 'running' ? null : resume);
    AgoraRTC.on('audio-context-state-changed', onContext);
    return () => {
      AgoraRTC.onAutoplayFailed = undefined;
      AgoraRTC.off('audio-context-state-changed', onContext);
    };
  }, []);

  useEffect(() => {
    cb.current.onLevels({ local: localMicrophoneTrack ?? null, remote: audioTracks[0] ?? null });
  }, [localMicrophoneTrack, audioTracks]);

  const quality = useRef<{ up: number; down: number } | null>(null);
  useClientEvent(client, 'network-quality', (q) => {
    quality.current = { up: q.uplinkNetworkQuality, down: q.downlinkNetworkQuality };
  });
  useEffect(() => {
    cb.current.onProbe({
      sample: () => {
        const sent = client.getLocalAudioStats();
        const received = client.getRemoteAudioStats()[AGENT_UID];
        return {
          rtt: client.getRTCStats().RTT,
          sent: { packets: sent.sendPackets, lost: sent.sendPacketsLost, jitterMs: sent.sendJitterMs },
          received: received && { packets: received.receivePackets, lost: received.receivePacketsLost },
          quality: quality.current,
        };
      },
      mic: localMicrophoneTrack ?? null,
    });
    return () => cb.current.onProbe(null);
  }, [client, localMicrophoneTrack]);

  useClientEvent(client, 'token-privilege-will-expire', async () => {
    try {
      const { rtcToken, rtmToken } = await onTokenWillExpire(String(client.uid));
      await client.renewToken(rtcToken);
      await rtmClient.renewToken(rtmToken);
    } catch {
      cb.current.onIssue('Could not renew the call token.');
    }
  });

  return null;
}
