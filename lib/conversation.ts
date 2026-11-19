import {
  TurnStatus,
  type AgentTranscription,
  type TranscriptHelperItem,
  type UserTranscription,
} from 'agora-agent-client-toolkit';
import { cleanSpokenText } from '@/lib/client/helpers';

type RawItem = TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>;

export interface TranscriptMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  createdAt?: number;
  streaming: boolean;
  // The agent was cut off mid-turn (barge-in or echo).
  interrupted: boolean;
}

// Fixes compacted punctuation emitted by some TTS/ASR providers ("Hello.World" -> "Hello. World").
function normalizeTranscriptSpacing(text: string): string {
  return text
    .replace(/([.!?])([A-Za-z])/g, '$1 $2')
    .replace(/,([A-Za-z])/g, ', $1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Agora timestamps vary by source: some RTM payloads use Unix seconds, RTC events use milliseconds.
function normalizeTimestampMs(timestamp: number): number {
  return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

// Toolkit transcript items to display messages. Anything not from the agent is the user; interrupted turns are kept.
export function toMessages(items: RawItem[], agentUid: string): TranscriptMessage[] {
  return items.map((item, index) => {
    const role = String(item.uid) === agentUid ? 'agent' : 'user';
    const raw = typeof item.text === 'string' ? item.text : '';
    return {
      id: `${role}-${item.turn_id ?? 'x'}-${index}`,
      role,
      text: cleanSpokenText(normalizeTranscriptSpacing(raw)),
      createdAt: typeof item._time === 'number' ? normalizeTimestampMs(item._time) : undefined,
      streaming: item.status === TurnStatus.IN_PROGRESS,
      interrupted: role === 'agent' && item.status === TurnStatus.INTERRUPTED,
    };
  });
}
