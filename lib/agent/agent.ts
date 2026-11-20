import { Agent, AgoraClient, Area, DeepgramSTT, ExpiresIn, MurfTTS, OpenAI, generateConvoAIToken } from 'agora-agents';
import { DEFAULT_AGENT_UID } from '@/lib/agora';
import type { Opener } from '@/lib/domain/opener';
import type { FollowUp, Persona, SessionState } from '@/lib/domain/types';
import { FAILURE_MESSAGE, buildAgoraTools, buildGreeting, buildSystemPrompt, interruptionSettings, murfConfig } from './config';

type Env = Record<string, string | undefined>;

export function agoraClient(env: Env = process.env) {
  // area: change to Area.EU or Area.AP to use a closer control-plane region.
  return new AgoraClient({ area: Area.US, appId: env.NEXT_PUBLIC_AGORA_APP_ID!, appCertificate: env.NEXT_AGORA_APP_CERTIFICATE! });
}

async function speak(agentId: string, text: string, priority: 'IGNORE' | 'APPEND', env: Env) {
  const token = generateConvoAIToken({ appId: env.NEXT_PUBLIC_AGORA_APP_ID!, appCertificate: env.NEXT_AGORA_APP_CERTIFICATE!, channelName: 'speak', uid: 0 });
  await agoraClient(env).agents.speak({ appid: env.NEXT_PUBLIC_AGORA_APP_ID!, agentId, text, priority, interruptable: true }, { headers: { Authorization: `agora token=${token}` } });
}

// Has a running agent say one line, only if it is not already talking or listening to someone.
export const speakWhenIdle = (agentId: string, text: string, env: Env = process.env) => speak(agentId, text, 'IGNORE', env);

// Has a running agent say one line as soon as it finishes what it is saying now.
export const speakNext = (agentId: string, text: string, env: Env = process.env) => speak(agentId, text, 'APPEND', env);

export function createAskItSession(opts: {
  client: AgoraClient;
  channel: string;
  requesterId: string;
  state: SessionState;
  baseUrl: string;
  now: number;
  persona: Persona;
  // The ticket a follow-up call is about, or the reminder being returned.
  callBack?: FollowUp | null;
  // What an employee call adds when the caller stays quiet after the greeting.
  opener?: Opener | null;
  env?: Env;
}) {
  const env = opts.env ?? process.env;
  const llmCommon = {
    systemMessages: [{ role: 'system', content: buildSystemPrompt(opts.now, opts.persona, opts.callBack, opts.state.asset, opts.state.tickets, opts.opener) }],
    greetingMessage: buildGreeting(opts.state, opts.persona, opts.callBack),
    failureMessage: FAILURE_MESSAGE,
    maxHistory: 32,
    params: { max_tokens: 300, temperature: 0.4 },
    // Set by the server, so the model can change neither the session nor the persona.
    templateVariables: { session_id: opts.state.id, persona: opts.persona },
    tools: buildAgoraTools(opts.baseUrl, env.TOOL_SECRET!, opts.persona),
  };
  // Default: Agora-managed gpt-4o-mini (no OpenAI key). Optional BYOK when both vars are set.
  const llm =
    env.NEXT_LLM_URL && env.NEXT_LLM_API_KEY
      ? new OpenAI({ ...llmCommon, apiKey: env.NEXT_LLM_API_KEY, url: env.NEXT_LLM_URL, model: env.NEXT_LLM_MODEL || 'gpt-4o-mini' })
      : new OpenAI({ ...llmCommon, model: 'gpt-4o-mini' });

  const barge = interruptionSettings(env);
  const agent = new Agent({
    client: opts.client,
    turnDetection: barge.turnDetection,
    ...(barge.interruption ? { interruption: barge.interruption } : {}),
    ...(barge.sal ? { sal: barge.sal } : {}),
    // RTM carries transcript/state to the browser; enable_tools turns on llm.tools.
    advancedFeatures: { enable_rtm: true, enable_tools: true, ...(barge.sal ? { enable_sal: true } : {}) },
    parameters: { audio_scenario: 'chorus', data_channel: 'rtm', enable_error_message: true, enable_metrics: true },
    // Filler phrases during tool calls; off by default because Murf then skipped the real answer.
    ...(env.AGENT_FILLER_WORDS === 'on'
      ? {
          fillerWords: {
            enable: true,
            trigger: { mode: 'fixed_time' as const, fixed_time_config: { response_wait_ms: 1500 } },
            content: { mode: 'static' as const, static_config: { phrases: ['One moment.', 'Checking that now.', 'Let me look that up.'], selection_rule: 'shuffle' as const } },
          },
        }
      : {}),
  })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en' }))
    .withLlm(llm)
    .withTts(new MurfTTS(murfConfig(env)));

  return agent.createSession({
    channel: opts.channel,
    agentUid: String(DEFAULT_AGENT_UID),
    remoteUids: [opts.requesterId],
    idleTimeout: 30, // agent leaves 30 s after the employee drops
    expiresIn: ExpiresIn.minutes(12), // hard backstop; the browser ends calls at 10 minutes
    debug: false,
  });
}

export function isAgentAlreadyStoppingOrStopped(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { statusCode?: number; body?: { detail?: string; reason?: string }; message?: string };
  if (e.statusCode === 404) return true;
  const detail = (e.body?.detail ?? e.message ?? '').toLowerCase();
  return e.body?.reason?.toLowerCase() === 'invalidrequest' && detail.includes('already in the process of shutting down');
}
