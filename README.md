# ASK IT

A voice IT helpdesk for employees. ASK IT resolves L1 issues by voice (guided fixes, self-service account
actions), and only raises a ticket when the fix fails, with the full troubleshooting log attached.
Built for **PS31: Voice AI at Work** (Build with Agora, Bengaluru).

The employee is Priya Sharma, a product manager at the fictional **Nimbus Labs** in Bengaluru. Her laptop
is NB-2231 (MacBook Pro, macOS 15) and she uses the GlobalProtect VPN client.

| Step | What happens |
| --- | --- |
| **Initiate** | Voice call over Agora; the greeting mentions any active outage |
| **Understand** | Live SaaS status pages, the internal outage board, BM25 search over guided fixes |
| **Execute** | Guided troubleshooting one step at a time, email-code verification, account unlock and resets, ServiceNow tickets |
| **Confirm** | Account actions, tickets and escalations are prepared first and only happen after a spoken yes (`confirmAction`, idempotent; `cancelAction`); errors are spoken honestly |
| **Follow up** | Tickets updated in ServiceNow, alerts to Slack or Discord, a call summary posted and stored as a document |

Each browser session gets a room code (such as `NMB-7K2`) and its own copy of the demo data; sessions
expire after 4 hours.

## Run it

Requires Node 22+ and pnpm.

```bash
cp env.local.example .env.local      # fill in the four required values
pnpm install
pnpm test                            # unit, adapter and route tests
pnpm build && pnpm start -p 3123     # http://localhost:3123
```

`pnpm verify` runs lint, typecheck, tests and the production build. `NEXT_DIST_DIR=.next-verify pnpm build`
builds into a separate folder while another server runs from `.next`.

**Live voice needs a public HTTPS URL.** Agora's cloud calls the tool endpoints (`/api/tools/*`), so set
`PUBLIC_BASE_URL` to a tunnel or deployment URL.

### Environment variables

| Variable | Required | Notes |
| --- | :---: | --- |
| `NEXT_PUBLIC_AGORA_APP_ID` | yes | Agora project App ID |
| `NEXT_AGORA_APP_CERTIFICATE` | yes | Server-side only |
| `MURF_API_KEY` | yes | Murf Falcon TTS |
| `TOOL_SECRET` | yes | Long random string; sent by Agora as `x-tool-secret` on every tool call |
| `PUBLIC_BASE_URL` | for voice | Public `https://` origin. On Vercel it defaults to the deployment URL |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | on Vercel | Shared state (`KV_REST_API_URL` / `KV_REST_API_TOKEN` also work) |
| `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USER`, `SERVICENOW_PASSWORD`, `SERVICENOW_CALLER_EMAIL` | no | All four switch tickets to the live ServiceNow Table API (Basic auth). Unset: simulated tickets |
| `SERVICENOW_CLOSE_CODE` | no | Resolution code for incidents ASK IT resolves. Default `Resolved – Permanent Fix Applied` (en dash) |
| `SERVICENOW_QUEUE_DAYS` | no | IT desk reads only incidents opened in the last N days. Default 30; 0 reads the whole queue |
| `SERVICENOW_OUTAGE_INCIDENT` | no | Live mode only: a real master incident (such as `INC0010123`) for the internal outage; its title and start time are read from ServiceNow when a session is created and before each call, and no affected count is claimed. Unset: no internal outage in live mode |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | no | Auth0 Management API (machine-to-machine app). MFA methods come from `authentication-methods`; if the tenant refuses, they are reported as unknown |
| `AUTH0_OTP_CLIENT_ID`, `AUTH0_OTP_CLIENT_SECRET` | no | Regular web app with the Passwordless OTP grant, for email codes |
| `AUTH0_USER_EMAIL` | no | The demo employee in Auth0. All six `AUTH0_*` switch identity to live; unset: simulated |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` | no | Slack bot (chat:write, invited to the channel): one live status card per issue, updated in place, each milestone also as a thread reply |
| `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` | no | Without the bot: one message per milestone (Discord wins if both are set). Unset: simulated |
| `MURF_VOICE_ID` / `MURF_LOCALE` | no | Default `Aarav` / `en-IN` |
| `NEXT_LLM_URL` / `NEXT_LLM_API_KEY` / `NEXT_LLM_MODEL` | no | Bring-your-own OpenAI-compatible LLM instead of the managed one |
| `AGENT_INTERRUPT_MS` | no | Speech (ms) needed to interrupt the speaking agent. Default `600`, clamped 160 to 3000 |
| `AGENT_INTERRUPT_KEYWORDS` | no | Comma-separated words; when set, only these interrupt the agent |
| `AGENT_SPEAKER_LOCK` | no | `true` enables Agora Selective Attention Locking (beta) |
| `AGENT_FILLER_WORDS` | no | `on` says a short phrase while a tool runs. Off by default: with Murf, the answer after a filler was not spoken |

Missing required variables show a setup screen listing their names, never values.

## How the voice pipeline is configured

`app/api/invite-agent/route.ts` starts the agent with the `agora-agents` SDK
(`lib/agent/agent.ts`, prompt/tools in `lib/agent/config.ts`). The request it sends to Agora's `/join`
(captured in `tests/routes.test.ts`) looks like:

```jsonc
{
  "preset": "deepgram_nova_3,openai_gpt_4o_mini",          // Agora-managed ASR + LLM, no vendor keys
  "properties": {
    "advanced_features": { "enable_rtm": true, "enable_tools": true },
    "parameters": { "data_channel": "rtm", "enable_error_message": true, "enable_metrics": true, "audio_scenario": "chorus" },
    "idle_timeout": 30,
    "turn_detection": { "config": { "speech_threshold": 0.5,
      "start_of_speech": { "mode": "vad", "vad_config": { "interrupt_duration_ms": 160, "speaking_interrupt_duration_ms": 600, "prefix_padding_ms": 300 } },
      "end_of_speech": { "mode": "vad", "vad_config": { "silence_duration_ms": 480 } } } },
        "llm": {
      "system_messages": [{ "role": "system", "content": "<who, device, date/time, voice, resolve-first and confirmation rules>" }],
      "greeting_message": "Hi Priya, this is ASK IT, the Nimbus Labs IT helpdesk. Heads-up: SAP Concur expense submissions failing right now ...",
      "failure_message": "Sorry, I didn't catch that. Could you say it again?",
      "max_history": 32,
      "params": { "max_tokens": 300, "temperature": 0.4 },
      "template_variables": { "session_id": "NMB-7K2" },
      "tools": [ /* 17 tools, see below */ ]
    },
    "tts": {
      "vendor": "murf",
      "params": { "api_key": "…", "model": "FALCON", "voiceId": "Aarav", "locale": "en-IN", "sample_rate": 24000 },
      "skip_patterns": [4, 5]                                // never voice [..] or {..}
    }
  }
}
```

- **TTS — Murf Falcon.** The SDK ships a `MurfTTS` class, so it is used directly; it emits exactly the
  documented `tts` block (`voiceId` camelCase). The default voice was checked against Murf's voice list;
  `Aarav` and `Priya` with `en-IN` both synthesise with the Falcon model.
- **LLM — Agora-managed `gpt-4o-mini` with tools.** In managed mode the SDK replaces the model/URL with
  the `openai_gpt_4o_mini` preset but keeps `llm.tools`, `template_variables` and the prompt in the
  payload; the docs describe tools for standard (non-custom) text LLMs. Not verified on a live call from
  this environment. If your project rejects tools on the managed model, set `NEXT_LLM_URL` +
  `NEXT_LLM_API_KEY` (BYOK OpenAI-compatible) and the same tools are sent.
- **ASR** — the quickstart's managed Deepgram nova-3.
- **Session limits** — the browser ends calls at 10 minutes (visible countdown); the agent's token
  expires at 12 minutes as a backstop; `idle_timeout: 30` stops the agent 30 s after the employee leaves.
- **Laptop speakers (echo / self-interruption)** — when ASK IT plays through speakers, its own
  voice can reach the mic and look like the employee talking, which cuts the reply short (the full text
  still shows in the transcript). Three layers handle this:
  1. The mic track is created with the Web SDK's 3A processing on: `AEC`, `ANS`, `AGC`
     (`MicrophoneAudioTrackInitConfig`, `lib/client/audio.ts`).
  2. `turn_detection.config.start_of_speech.vad_config.speaking_interrupt_duration_ms` (default 600 ms,
     `AGENT_INTERRUPT_MS`) means a short burst of echo or noise does not interrupt the agent while it speaks;
     `interrupt_duration_ms` stays 160 ms so normal turn-taking is still fast.
  3. Stronger, opt-in: `AGENT_INTERRUPT_KEYWORDS` sets `interruption: { enable: true, mode: "keywords",
     keywords_config: { trigger_keywords } }`, so only those words interrupt; `AGENT_SPEAKER_LOCK=true` sets
     `sal: { sal_mode: "locking" }` + `advanced_features.enable_sal` (beta).
  Interrupted agent turns are labelled "interrupted" in the transcript, and the Inspector lists the raw
  agent events received over RTM (errors with module/code, interruptions, per-turn latency, metrics). A TTS
  error shows a banner in the call. The agent's audio track is subscribed and played once explicitly; if the
  browser blocks or suspends audio an "Enable sound" button resumes it, and a "No sound?" hint appears when
  the agent is speaking but no audio level is detected for 2 s.
- **Spoken style** — the prompt forbids markdown, lists, emojis and asterisks, and the transcript
  renderer strips stray markdown defensively (`lib/client/helpers.ts`).
- **If Murf fails** — `failure_message` is spoken when the *LLM* call fails, and it is also rendered by
  TTS, so it cannot cover a TTS outage. With `enable_error_message` the engine reports module errors over
  RTM; the employee screen shows them as a banner and the text replies keep arriving in the transcript.

### Tools

One registry (`lib/domain/tools/`) drives the Agora HTTP tools, the MCP server and the route handler.
Every parameter is a required string (`""` means not given), names match `^[a-zA-Z][a-zA-Z0-9]{0,63}$`.
Each result has `say`, plain text for the employee, and sometimes `next`, an instruction the agent follows
but never reads aloud.

| Tool | What it does |
| --- | --- |
| `checkServiceStatus(service)` | Internal outage board (VPN, Wi-Fi, Outlook, SAP Concur, printers) or the live public status page (GitHub, Jira, Confluence, Slack, Gmail, Google Meet, Google Drive, Dropbox, Figma, ChatGPT) |
| `followOutage(incident)` | Adds Priya as affected to the master incident instead of a duplicate ticket |
| `searchKnowledge(query)` | BM25 over 10 guided fixes written for macOS |
| `startTroubleshooting(articleId, issue)` | Opens a guided fix and returns step 1 |
| `reportStep(outcome, note)` | `fixed`, `not_fixed`, `done` or `skipped`; returns the next step or says the steps ran out |
| `markResolved(summary)` | Logs a resolved incident ("resolved by ASK IT") so deflection is countable; the same resolution is logged once |
| `verifyIdentity()` | Emails a six-digit code |
| `checkIdentity(code)` | Checks the spoken code; valid 10 minutes, 3 tries per code, codes expire after 5 minutes |
| `getAccountStatus()` | Locked or not, last password reset, MFA methods |
| `prepareAccountAction(action)` | `unlock`, `resetPassword` or `resetMfa`; needs a valid verification |
| `prepareTicket(summary, urgency, details)` | Ticket with the troubleshooting log, device and verification state attached |
| `listMyTickets(status)` | Refreshes from ServiceNow; on failure returns the last list and says it may be stale |
| `addTicketNote(ticket, note)` | Accepts spoken numbers ("I N C 12001", "ticket 12001") |
| `prepareEscalation(ticket, reason)` | Escalates to urgency 1 after a yes and alerts IT |
| `confirmAction(code)` / `cancelAction(code)` | Commit (idempotent, one commit even when calls race) or discard. A failed or unanswered commit keeps the same code, and a retry looks the ticket up first |
| `wrapUpCall()` | Call summary: posted to the IT channel and stored as a document |

### IT desk persona

`POST /api/invite-agent` takes an optional `persona`: `"employee"` (default) or `"itdesk"`. The IT desk
persona lets IT engineers triage every open ServiceNow incident (New, In Progress, On Hold) by voice, with
its own prompt, greeting and tools. The persona is a server-set template variable sent with every tool
call, so the model cannot switch it; a tool outside the call's persona answers 403.

| Tool | What it does |
| --- | --- |
| `listQueue(filter, limit)` | `critical`, `high`, `unassigned`, `new`, `onhold` or `all`; highest priority, then oldest; up to 8 |
| `openIncident(ticket)` | By number, by position in the last list ("the second one") or by title words; says what is missing |
| `prepareIncidentUpdate(...)` | All changes for one incident in one read-back: assignee, group, state, hold reason, urgency, impact, category, work note, comment, resolution notes. Asks "which David?" when a name is ambiguous; a new prepare replaces the older one |
| `confirmAction` / `cancelAction` | Shared with the employee persona; saves with one PATCH and reads the record back |

Without ServiceNow credentials a simulated queue of seven incidents (three critical) is used.

### MCP

`POST /api/mcp?session=CODE&persona=employee|itdesk` (header `x-tool-secret` or `Authorization: Bearer`) exposes the same tools
over JSON-RPC (`initialize`, `tools/list`, `tools/call`).

## Architecture

- `lib/domain/` holds the pure parts: seed, knowledge base and search, service catalog, ticket helpers,
  the tool registry and the read model (`view.ts`) for both screens.
- `lib/integrations/` holds one adapter per system. Each has `mode: 'live' | 'simulated'`; live is used
  when its env is set. Every outbound call has its own timeout (4 s for ServiceNow and Auth0, 5.5 s for a ServiceNow create, 3 s for
  status pages and webhooks) and all calls of one tool share a 6.5 s deadline, well under Agora's 10 s.
  Failures are typed results; spoken errors never contain URLs or credentials.
- `lib/server/execute.ts` runs a tool in three steps: an optional claim (so `confirmAction` commits once),
  the outbound effect exactly once, then the pure reducer inside the optimistic `updateSession`, which
  may retry. Outbound calls never run inside the reducer.
- Live failures degrade honestly: a ticket that cannot be created is kept as a local record marked
  `syncFailed` and the confirmation stays open for a retry. Each create sends a `correlation_id`; when the
  answer is lost (timeout, network) the incident is looked up by it, so a retry never duplicates it.
- Slack or Discord alerts are queued by the tool and sent with `after()` once the response is out, so
  they never count against the tool's time budget, one at a time so a card's milestones stay in order.
  Their status (`queued`, `sent`, `failed`) is in state.
- With a Slack bot each issue gets one live card in the channel: status emoji and label, the issue title,
  then employee, device, ticket and time. Milestones (opened, in progress, waiting for the employee,
  resolved by ASK IT, ticket raised, escalated, assigned, on hold, resolved by IT) update it in place and
  add a thread reply. The card's Slack `ts` is kept for 7 days under `askit:slack:<key>`, keyed by the
  ticket number once there is one (so IT desk updates from any session reach the same card), else by
  `<session>:<issue>`. Creation is claimed in the store, so racing deliveries never post two cards; a
  deleted card is posted again.
- Public status pages need no keys, are cached for 60 s, and an unreachable page is reported as unknown,
  never as operational.

### Demo data

Seeded per session in simulated ticket mode: Priya's account starts locked, two earlier tickets (INC0011987 resolved, INC0011994 in
progress), and one active internal outage: SAP Concur expense submissions failing, master incident
INC0011950, 14 affected. VPN has no outage, so a VPN problem goes through guided troubleshooting. In
simulated mode new tickets are numbered from INC0012001 and the emailed code is shown on screen as a
simulated inbox (never in tool results the agent sees). In live ticket mode no simulated tickets are seeded,
and the outage exists only while the open incident `SERVICENOW_OUTAGE_INCIDENT` names says so in ServiceNow. With live
Auth0 the account starts unknown and is read from Auth0 when the session is created and before each call; if
that read fails the Account card says so instead of showing values. `/api/state` masks the employee's email.

## Tests

`pnpm test` runs vitest over `tests/`: the HTTP helper, ServiceNow, Auth0, status-page and webhook
adapters against fake `fetch` (URLs, methods, headers, bodies, 401, 404, 5xx, timeouts, malformed JSON,
network errors, no secrets in errors), every tool and its edge cases, concurrency and claims, the read
model, the store and sessions, agent config, client helpers, and the route handlers.

## Credits

Built on Agora's official Next.js Conversational AI quickstart (MIT, see `LICENSE`). The bracketed audio
visualizer is adapted from Agora's community voice demos (MIT).
