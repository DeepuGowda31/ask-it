// Echo cancellation, noise suppression and gain control for the mic, so the agent's voice from the speakers does not interrupt it.
export const MIC_TRACK_CONFIG = { AEC: true, ANS: true, AGC: true } as const;

// Agent "speaking" for over 2 s with no audible remote audio suggests a playback problem.
export function noSoundSuspected({ speakingSince, lastAudibleAt, now }: { speakingSince: number | null; lastAudibleAt: number; now: number }): boolean {
  if (speakingSince === null) return false;
  return now - Math.max(speakingSince, lastAudibleAt) > 2000;
}

// Banner text for agent errors that affect what the employee hears (TTS only).
export function agentErrorBanner(error: { type: string; code: number; message: string }): string | null {
  if (error.type !== 'tts') return null;
  return `The ASK IT voice reported an error (TTS ${error.code}: ${error.message}). Replies still appear in the transcript.`;
}
