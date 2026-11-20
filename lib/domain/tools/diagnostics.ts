import { nextId } from '../actions';
import { EMPLOYEE } from '../company';
import { FOCUSES, diagnose, type DiagnosticFocus, type DiagnosticResults, type Finding } from '../diagnose';
import { findArticle } from '../kb';
import { confident, rankKnowledge } from '../search';
import type { Diagnostics, SessionState } from '../types';
import { failed, ok, plural, tool, type Outcome } from './shared';

// Waiting plus the store round trips stays inside the 6.5 s effect budget and Agora's 8 s tool timeout.
export const DIAGNOSTICS_WAIT_MS = 6000;
const POLL_MS = 200;
// A request older than this was abandoned: a new run replaces it and late results are refused.
const STALE_MS = DIAGNOSTICS_WAIT_MS + 2000;

// The guide to offer when the checks find nothing, or cannot run.
const FOCUS_GUIDE: Record<DiagnosticFocus, string> = { calls: 'meeting-audio', audio: 'meeting-audio', network: 'wifi', signin: 'sso-loop', general: 'slow-laptop' };

const inFlight = (d: Diagnostics | null | undefined, now: number) => d?.status === 'requested' && now - d.requestedAt < STALE_MS;
const guideTitle = (id: string) => findArticle(id)?.title ?? id;

// A guide that clearly matches their words wins over the check's usual one in the same area, so "at home on a hotspot" never gets office Wi-Fi.
function pickGuide(usual: string, problem: string): string {
  const hit = problem.trim() ? rankKnowledge(problem)[0] : undefined;
  if (!hit || !confident(hit)) return usual;
  return findArticle(usual)?.category === hit.article.category ? hit.article.id : usual;
}
const startGuide = (id: string) => `If they agree, call startTroubleshooting with articleId ${id}.`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RecordOutcome = 'accepted' | 'duplicate' | 'unknown' | 'expired';

// The browser's results for the current request; only the first post for an id counts.
export function recordDiagnostics(state: SessionState, id: string, results: DiagnosticResults, now: number): { state: SessionState; outcome: RecordOutcome } {
  const d = state.diagnostics;
  if (!d || d.id !== id) return { state, outcome: 'unknown' };
  if (d.status === 'done') return { state, outcome: 'duplicate' };
  if (d.status !== 'requested' || now - d.requestedAt > STALE_MS) return { state, outcome: 'expired' };
  return { state: { ...state, diagnostics: { ...d, status: 'done', doneAt: now, results, findings: diagnose(results, d.focus) } }, outcome: 'accepted' };
}

function spoken(focus: DiagnosticFocus, findings: Finding[], choose: (usual: string) => string): Outcome {
  const issues = findings.filter((f) => f.relevant && f.severity !== 'ok');
  const data = { focus, findings: findings.slice(0, 6).map(({ key, severity, say }) => ({ key, severity, say })) };
  if (issues.length) {
    const guide = issues[0].guide ? choose(issues[0].guide) : null;
    const advice = guide ? ` The guide "${guideTitle(guide)}" should help. Shall we go through it?` : '';
    const next = guide ? startGuide(guide) : 'Ask whether that fixed it. If not, call searchKnowledge for the problem.';
    return { title: `Laptop check · ${focus} · ${plural(issues.length, 'issue')}`, result: ok(`${issues.slice(0, 2).map((f) => f.say).join(' ')}${advice}`, { ...data, guide }, next) };
  }
  const guide = choose(FOCUS_GUIDE[focus]);
  const fine = findings.find((f) => f.relevant);
  if (!fine) {
    const say = `Your browser could not give me any readings for that, so I can't tell from here. Shall we go through "${guideTitle(guide)}" instead?`;
    return failed(`Laptop check · ${focus} · no readings`, 'checks_unavailable', say, undefined, startGuide(guide));
  }
  const say = `Everything I could check looks fine. ${fine.say} So the problem is probably not your connection or laptop. Shall we go through "${guideTitle(guide)}"?`;
  return { title: `Laptop check · ${focus} · all fine`, result: ok(say, { ...data, guide }, startGuide(guide)) };
}

const runDiagnostics = tool<string>({
  name: 'runDiagnostics',
  description:
    `Run live checks on the laptop ${EMPLOYEE.firstName} is calling from, in the browser: call packet loss, round trip and jitter, whether Slack, GitHub, Google and Microsoft sign-in answer, microphone, speakers, camera permission, clock and battery. Use it first for network, call quality, audio, slowness or sign-in problems. Takes a few seconds.`,
  params: {
    focus: { description: 'calls for call quality, network, audio, signin, or general for slowness and anything else', enum: FOCUSES },
    problem: { description: 'The problem in their words, with where they are and their device, e.g. "no internet at home on a phone hotspot"', allowEmpty: true },
  },
  minutesSaved: 3,
  // Records the request before the wait, so the browser sees it; a call while one runs joins it.
  begin(state, args, now) {
    if (inFlight(state.diagnostics, now)) return false;
    state.diagnostics = { id: nextId(state, 'DX'), focus: args.focus as DiagnosticFocus, status: 'requested', requestedAt: now };
    return true;
  },
  // Polls the stored session until the browser's results land or the wait runs out; returns the request id.
  async effect({ state, reload }) {
    const id = state.diagnostics?.status === 'requested' ? state.diagnostics.id : undefined;
    if (!id) return undefined;
    const until = Date.now() + DIAGNOSTICS_WAIT_MS;
    for (;;) {
      const d = (await reload())?.diagnostics;
      if (d?.id !== id || d.status !== 'requested' || Date.now() >= until) return id;
      await sleep(POLL_MS);
    }
  },
  run({ state, effect }, args) {
    const d = state.diagnostics;
    if (!d || d.id !== effect) return failed(`Laptop check · ${args.focus} · not started`, 'try_again', "The laptop check didn't start. Please try again.");
    if (d.status === 'requested') d.status = 'timeout';
    if (d.status === 'timeout') {
      const guide = pickGuide(FOCUS_GUIDE[d.focus], args.problem ?? '');
      const say = `I couldn't run the checks from your browser just now, so let's go through the steps together instead. Shall we start "${guideTitle(guide)}"?`;
      return failed(`Laptop check · ${d.focus} · browser did not answer`, 'checks_unavailable', say, undefined, startGuide(guide));
    }
    return spoken(d.focus, d.findings ?? [], (usual) => pickGuide(usual, args.problem ?? ''));
  },
});

export const DIAGNOSTICS_TOOLS = [runDiagnostics];
