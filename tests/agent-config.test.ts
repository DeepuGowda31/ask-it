import { describe, expect, it } from 'vitest';
import { IT_INTRO, buildAgoraTools, buildGreeting, buildSystemPrompt, missingEnv, resolvePublicBaseUrl, murfConfig } from '@/lib/agent/config';
import { getTool, toolsFor } from '@/lib/domain/tools';
import { DAY } from '@/lib/domain/time';
import { NOW, confirmed, freshState } from './helpers';

describe('public base URL for tool callbacks', () => {
  it('prefers PUBLIC_BASE_URL and strips trailing slashes', () => {
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://askit.example.com/' })).toEqual({ ok: true, url: 'https://askit.example.com' });
  });
  it('falls back to Vercel URLs', () => {
    expect(resolvePublicBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'askit.vercel.app', VERCEL_URL: 'x.vercel.app' })).toEqual({ ok: true, url: 'https://askit.vercel.app' });
    expect(resolvePublicBaseUrl({ VERCEL_URL: 'x-123.vercel.app' })).toEqual({ ok: true, url: 'https://x-123.vercel.app' });
  });
  it('refuses localhost and plain http with a clear reason', () => {
    const none = resolvePublicBaseUrl({});
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toMatch(/PUBLIC_BASE_URL/);
    const http = resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'http://localhost:3000' });
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.reason).toMatch(/https/i);
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://localhost:3000' }).ok).toBe(false);
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'not a url' }).ok).toBe(false);
  });
});

describe('Agora tool definitions', () => {
  const tools = buildAgoraTools('https://askit.example.com', 'secret-123');
  it('has one HTTPS POST tool per registry entry', () => {
    expect(tools).toHaveLength(toolsFor('employee').length);
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(t.function.name).toMatch(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/);
      expect(t.function.description?.length ?? 0).toBeLessThanOrEqual(1024);
      expect(t.server.method).toBe('POST');
      expect(t.server.url).toBe(`https://askit.example.com/api/tools/${t.function.name}`);
      expect(t.server.headers).toEqual({ 'x-tool-secret': 'secret-123', 'Content-Type': 'application/json' });
      expect(t.server.timeout_ms).toBeGreaterThanOrEqual(7000);
      expect(t.server.timeout_ms).toBeLessThanOrEqual(10000);
      expect(t.execution).toEqual({ mode: 'sync' });
    }
  });
  it('maps every parameter into the body as a whole placeholder and marks all as required', () => {
    for (const t of tools) {
      const params = t.function.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
      expect(params.type).toBe('object');
      expect(params.required.sort()).toEqual(Object.keys(params.properties).sort());
      const body = t.server.body as { session_id: string; tool_call_id: string; args: Record<string, string> };
      expect(body.session_id).toBe('{{template_variables.session_id}}');
      expect(body.tool_call_id).toBe('{{tool_call_id}}');
      expect((body as unknown as { persona: string }).persona).toBe('{{template_variables.persona}}');
      for (const k of Object.keys(params.properties)) expect(body.args[k]).toBe(`{{args.${k}}}`);
    }
  });
  it('keeps secrets out of everything the model can see', () => {
    const visible = JSON.stringify(tools.map((t) => t.function));
    expect(visible).not.toContain('secret-123');
  });
});

describe('prompt and greeting', () => {
  const p = buildSystemPrompt(NOW);
  it('says who, where, when and on what device', () => {
    expect(p).toMatch(/^You are ASK IT, the voice IT helpdesk of Nimbus Labs/);
    expect(p).toMatch(/Priya Sharma/);
    expect(p).toMatch(/NB-2231, a MacBook Pro on macOS 15/);
    expect(p).toMatch(/GlobalProtect/);
    expect(p).toMatch(/Wednesday 18 November 2026, 9:30 AM/);
  });
  it('states the working rules', () => {
    expect(p).toMatch(/no markdown/i);
    expect(p).toMatch(/resolve first, ticket last/i);
    expect(p).toMatch(/one step at a time/i);
    expect(p).toMatch(/Is it working now\?/);
    expect(p).toMatch(/I-N-C one two zero zero one/);
    expect(p).toMatch(/explicit yes/i);
    expect(p).toMatch(/confirmAction/);
    expect(p).toMatch(/checkIdentity/);
    expect(p).toMatch(/After an account action, ask whether Priya can sign in now, and call markResolved when she says yes/);
    expect(p).toMatch(/lost or stolen.*act fast.*prepareSecurityLockdown.*no email code/i);
    expect(p).toMatch(/network, call quality, audio, slowness or sign-in problem.*runDiagnostics first.*finding with its number.*startTroubleshooting/);
    expect(p).toMatch(/`next`.*never read it aloud/);
    for (const t of toolsFor('employee')) expect(p).toContain(t.name);
    expect(p).not.toMatch(/listQueue|countIncidents|showDashboard|showImpact|prepareIncidentUpdate/);
  });
  it('turns requests into a well-described ticket and reads ServiceNow articles', () => {
    expect(p).toMatch(/Requests are not fixes: new software, new hardware, or access to an app, shared drive, mailbox or group/);
    expect(p).toMatch(/prepareTicket with a summary that names the item/);
    expect(p).toMatch(/"Install Adobe Acrobat Pro"/);
    expect(p).toMatch(/business reason and the approver in details/);
    expect(p).toMatch(/ServiceNow article.*read its summary in plain words/);
  });
  it('never mentions the old product', () => {
    expect(p).not.toMatch(/workday|copilot|okta/i);
  });
  it('greets with the active outage when she has no open ticket, built on the server', async () => {
    const s = freshState();
    s.tickets = s.tickets.filter((t) => t.state === 'Resolved');
    const g = buildGreeting(s);
    expect(g).toBe('Hi Priya, this is ASK IT, the Nimbus Labs IT helpdesk. Heads-up: SAP Concur expense submissions failing right now, and IT is working on it. What can I help you with?');
    expect(g).not.toMatch(/[*#_`]/);
    const followed = (await confirmed(s, 'followOutage', { incident: '' })).state;
    expect(buildGreeting(followed)).toBe('Hi Priya, this is ASK IT, the Nimbus Labs IT helpdesk. What can I help you with?');
  });
  it('names her most relevant open ticket and asks whether the call is about it', async () => {
    const followed = (await confirmed(freshState(), 'followOutage', { incident: '' })).state;
    expect(buildGreeting(followed)).toBe('Hi Priya, this is ASK IT. I see your ticket I-N-C one one nine nine four, Figma licence request, is still in progress. Is this about that, or something new?');
  });
  it('keeps the outage heads-up next to her ticket, in two sentences and the question', () => {
    const g = buildGreeting(freshState());
    expect(g).toBe('Hi Priya, this is ASK IT, and heads-up: SAP Concur expense submissions failing right now. I see your ticket I-N-C one one nine nine four, Figma licence request, is still in progress. Is this about that, or something new?');
    expect(g.split(/(?<=[.?])\s/)).toHaveLength(3);
  });
  it('picks the latest updated open ticket that ServiceNow has, and says "open" for new ones', () => {
    const s = freshState();
    s.outages = [];
    s.tickets.unshift(
      { number: 'LOCAL-9', sysId: null, summary: 'Not sent', state: 'Not submitted', urgency: 2, source: 'live', createdAt: NOW, updatedAt: NOW, syncFailed: true },
      { number: 'INC0012005', sysId: 's5', summary: 'Resolved by ASK IT: VPN fixed', state: 'New', urgency: 3, source: 'live', createdAt: NOW, updatedAt: NOW, syncFailed: true },
      { number: 'INC0012003', sysId: 's3', summary: 'Dock (USB-C) [left port] not charging', state: 'New', urgency: 2, source: 'live', createdAt: NOW - 3 * DAY, updatedAt: NOW - 60_000 },
      { number: 'INC0012004', sysId: 's4', summary: 'Mouse broken', state: 'Resolved', urgency: 3, source: 'live', createdAt: NOW, updatedAt: NOW },
    );
    expect(buildGreeting(s)).toBe('Hi Priya, this is ASK IT. I see your ticket I-N-C one two zero zero three, Dock USB-C left port not charging, is still open. Is this about that, or something new?');
  });
  it('lets a scanned device win over her ticket, and a follow-up or reminder call win over both', () => {
    const s = freshState();
    s.asset = { id: 'printer-3f', ticket: null };
    expect(buildGreeting(s)).toMatch(/^Hi Priya, this is ASK IT\. You're at the printer by the 3rd floor pantry\. What's going wrong\?$/);
    expect(buildGreeting(s, 'employee', { number: 'INC0010013', summary: 'VPN down' })).toMatch(/calling about I-N-C one zero zero one three/);
    expect(buildGreeting(s, 'employee', { number: '', summary: 'the VPN fix', reminder: 'RM-1' })).toBe("Hi Priya, it's ASK IT checking back about the VPN fix. Is it working now?");
  });
  it('briefs the agent with her open tickets from the first turn', () => {
    const p = buildSystemPrompt(NOW, 'employee', null, null, freshState().tickets);
    expect(p).toMatch(/Her open tickets\n- INC0011994, Figma licence request: in progress, low urgency\./);
    expect(p).not.toMatch(/INC0011987/);
    expect(buildSystemPrompt(NOW)).toMatch(/Her open tickets\n- None right now\./);
    const many = Array.from({ length: 8 }, (_, i) => ({ ...freshState().tickets[0], number: `INC00200${i}`, summary: `Issue\n${i}` }));
    const listed = buildSystemPrompt(NOW, 'employee', null, null, many).match(/^- INC00200/gm) ?? [];
    expect(listed).toHaveLength(5);
    expect(buildSystemPrompt(NOW, 'employee', null, null, many)).toMatch(/INC002000, Issue 0:/);
  });
  it('briefs a reminder call', () => {
    const p = buildSystemPrompt(NOW, 'employee', { number: 'INC0011994', summary: 'the Figma licence', reminder: 'RM-1' });
    expect(p).toMatch(/This call\n- Priya asked you to check back about the Figma licence, ticket INC0011994/);
    expect(p).toMatch(/Do not offer another reminder/);
    expect(p).not.toMatch(/call confirmFix with ticket/);
  });
  it('asks for a yes before every ticket change, and offers one reminder', () => {
    expect(p).toMatch(/new tickets, escalations, ticket notes, joining an outage and logging a fix take two steps/);
    expect(p).toMatch(/prepareTicket, prepareEscalation, addTicketNote, followOutage or markResolved/);
    expect(p).toMatch(/Never change a ticket or log a fix without her yes/);
    expect(p).toMatch(/After you raise a ticket or finish a fix, offer one reminder.*scheduleReminder/);
    expect(p).toMatch(/at most once per call/);
  });
  it('tells the agent that her answer on a follow-up call is the confirmation', () => {
    expect(p).toMatch(/confirmFix.*fixed closes.*not_fixed reopens.*her answer is the confirmation/i);
    expect(getTool('confirmFix')!.description).toMatch(/Her spoken answer to the follow-up question is the approval: call it straight away, never ask for another yes\./);
    expect(p).not.toMatch(/This call/);
  });
  it('greets a follow-up call with the ticket and asks whether it works now', () => {
    const f = { number: 'INC0010013', summary: 'GlobalProtect VPN not connecting' };
    expect(buildGreeting(freshState(), 'employee', f)).toBe('Hi Priya, this is ASK IT calling about I-N-C one zero zero one three, GlobalProtect VPN not connecting. IT marked it resolved. Is it working for you now?');
    const prompt = buildSystemPrompt(NOW, 'employee', f);
    expect(prompt).toMatch(/This call\n- You called Priya back about INC0010013, GlobalProtect VPN not connecting/);
    expect(prompt).toMatch(/call confirmFix with ticket INC0010013/);
    expect(prompt).toMatch(/Do not ask for another yes/);
    expect(buildGreeting(freshState(), 'itdesk', f)).toMatch(/^Hi, I'm your IT Admin voice agent/);
  });
});

describe('environment checks', () => {
  it('lists missing variables by name only', () => {
    expect(missingEnv({})).toEqual(['NEXT_PUBLIC_AGORA_APP_ID', 'NEXT_AGORA_APP_CERTIFICATE', 'MURF_API_KEY', 'TOOL_SECRET']);
    expect(missingEnv({ NEXT_PUBLIC_AGORA_APP_ID: 'a', NEXT_AGORA_APP_CERTIFICATE: 'b', MURF_API_KEY: 'c', TOOL_SECRET: 'd' })).toEqual([]);
  });
  it('defaults Murf to an Indian-English Falcon voice', () => {
    expect(murfConfig({ MURF_API_KEY: 'k' })).toMatchObject({ key: 'k', model: 'FALCON', voiceId: 'Aarav', locale: 'en-IN', sampleRate: 24000 });
    expect(murfConfig({ MURF_API_KEY: 'k', MURF_VOICE_ID: 'Priya', MURF_LOCALE: 'en-IN' }).voiceId).toBe('Priya');
  });
});

import { interruptionSettings } from '@/lib/agent/config';

describe('barge-in robustness', () => {
  it('requires ~600 ms of speech before interrupting the speaking agent by default', () => {
    const s = interruptionSettings({});
    expect(s.turnDetection.config.start_of_speech).toEqual({
      mode: 'vad',
      vad_config: { interrupt_duration_ms: 160, speaking_interrupt_duration_ms: 600, prefix_padding_ms: 300 },
    });
    expect(s.turnDetection.config.end_of_speech).toEqual({ mode: 'vad', vad_config: { silence_duration_ms: 480 } });
    expect(s.interruption).toBeUndefined();
  });
  it('reads AGENT_INTERRUPT_MS and clamps silly values', () => {
    expect(interruptionSettings({ AGENT_INTERRUPT_MS: '800' }).turnDetection.config.start_of_speech.vad_config.speaking_interrupt_duration_ms).toBe(800);
    expect(interruptionSettings({ AGENT_INTERRUPT_MS: '20' }).turnDetection.config.start_of_speech.vad_config.speaking_interrupt_duration_ms).toBe(160);
    expect(interruptionSettings({ AGENT_INTERRUPT_MS: '99999' }).turnDetection.config.start_of_speech.vad_config.speaking_interrupt_duration_ms).toBe(3000);
    expect(interruptionSettings({ AGENT_INTERRUPT_MS: 'abc' }).turnDetection.config.start_of_speech.vad_config.speaking_interrupt_duration_ms).toBe(600);
  });
  it('switches to keyword-only interruption when AGENT_INTERRUPT_KEYWORDS is set', () => {
    expect(interruptionSettings({ AGENT_INTERRUPT_KEYWORDS: ' stop , wait,, helpdesk ' }).interruption).toEqual({
      enable: true,
      mode: 'keywords',
      keywords_config: { trigger_keywords: ['stop', 'wait', 'helpdesk'] },
    });
  });
});

describe('speaker lock (SAL)', () => {
  it('is off by default and opt-in via AGENT_SPEAKER_LOCK', () => {
    expect(interruptionSettings({}).sal).toBeUndefined();
    expect(interruptionSettings({ AGENT_SPEAKER_LOCK: 'true' }).sal).toEqual({ sal_mode: 'locking' });
    expect(interruptionSettings({ AGENT_SPEAKER_LOCK: '0' }).sal).toBeUndefined();
  });
});

describe('IT desk persona', () => {
  it('gets only the IT desk tools', () => {
    const tools = buildAgoraTools('https://askit.example.com', 'secret-123', 'itdesk');
    expect(tools.map((t) => t.function.name).sort()).toEqual(['cancelAction', 'confirmAction', 'countIncidents', 'listQueue', 'listResources', 'openIncident', 'prepareIncidentUpdate', 'requestUpdate', 'showDashboard', 'showImpact', 'showResource']);
  });
  it('has its own prompt and greeting for IT engineers', () => {
    const p = buildSystemPrompt(NOW, 'itdesk');
    expect(p).toMatch(/^You are ASK IT on the Nimbus Labs IT desk/);
    for (const t of toolsFor('itdesk')) expect(p).toContain(t.name);
    expect(p).toMatch(/one at a time/i);
    expect(p).toMatch(/no markdown/i);
    expect(p).toMatch(/explicit yes/i);
    expect(p).toMatch(/never read it aloud/);
    expect(p).toMatch(/listQueue[^\n]*short summary[^\n]*never read the incidents one by one/i);
    expect(p).toMatch(/picks one[^\n]*call openIncident/);
    expect(p).not.toMatch(/Read out only the first few items/);
    expect(p).toMatch(/showDashboard[^\n]*on hold[^\n]*resolved today[^\n]*oldest/);
    expect(p).not.toMatch(/Priya Sharma|checkServiceStatus|workday|copilot|okta/i);
    expect(buildGreeting(freshState(), 'itdesk')).toBe("Hi, I'm your IT Admin voice agent. How can I help?");
    expect(IT_INTRO).toMatch(/ServiceNow/);
    expect(IT_INTRO).not.toMatch(/You can say/);
    expect(new TextEncoder().encode(IT_INTRO).length).toBeLessThanOrEqual(512);
    expect(IT_INTRO.split(/\s+/).length).toBeLessThanOrEqual(26);
  });
});
