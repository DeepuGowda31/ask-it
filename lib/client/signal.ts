// Visualizer state, adapted from Agora's community voice demos (MIT).
export type SignalState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error' | 'ended';

export interface AudioLevelSource {
  getVolumeLevel(): number;
}

export interface SignalSnapshot {
  state: SignalState;
  micEnabled: boolean;
  levelSource?: AudioLevelSource | null;
}

// Transport health wins over stale agent state.
export function mapSignalState(agentState: string | null, agentInChannel: boolean, connectionState: string, hasError = false): SignalState {
  if (hasError || connectionState === 'DISCONNECTED' || connectionState === 'DISCONNECTING') return 'error';
  if (connectionState === 'CONNECTING' || connectionState === 'RECONNECTING' || !agentInChannel) return 'connecting';
  if (agentState === 'listening' || agentState === 'thinking' || agentState === 'speaking') return agentState;
  return 'listening';
}

// Fast attack, slower release, so measured audio stays readable.
export function smoothAudioLevel(raw: number, previous: number, deltaSeconds: number): number {
  const target = Math.sqrt(Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0)));
  const rate = target > previous ? 22 : 7;
  return previous + (target - previous) * (1 - Math.exp(-Math.max(0, deltaSeconds) * rate));
}

export const SIGNAL_CAPTION: Record<SignalState, string> = {
  idle: 'Ready when you are',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Working on it…',
  speaking: 'Talking with you',
  error: 'Connection needs attention',
  ended: 'Call ended',
};
