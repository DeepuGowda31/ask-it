import { describeFailure, success, type Failure, type Result } from '@/lib/integrations/http';
import type { AccountAction, AccountInfo, IdentityAdapter, Mode } from '@/lib/integrations/types';
import { issueMilestone } from '../cards';
import { CODE_TTL_MS, EMPLOYEE, MAX_CODE_ATTEMPTS, VERIFICATION_TTL_MS } from '../company';
import { clip, spokenDigits } from '../tickets';
import { DAY, MINUTE } from '../time';
import type { SessionState, Verification, VerificationStatus } from '../types';
import { failed, ok, plural, prepare, tool, type Outcome } from './shared';

const CODE_SENT_SAY = "I've emailed a six-digit code to your work address; read it to me when it arrives.";

// Status as of `now`: approvals and unused codes both run out.
export function verificationStatus(v: Verification, now: number): VerificationStatus {
  if (v.status === 'approved' && now > (v.expiresAt ?? 0)) return 'expired';
  if (v.status === 'pending' && now > (v.sentAt ?? 0) + CODE_TTL_MS) return 'expired';
  return v.status;
}

export const isVerified = (state: SessionState, now: number) => verificationStatus(state.verification, now) === 'approved';

// Why an account action may not run yet, or null when the employee is verified.
export function verificationBlock(state: SessionState, now: number): { error: string; say: string } | null {
  if (isVerified(state, now)) return null;
  if (state.verification.approvedAt !== null) return { error: 'verification_expired', say: "Your verification has expired. I'll need to email you a new code first." };
  return { error: 'verification_required', say: "For your security I need to verify you first. I'll email a six-digit code to your work address. Shall I send it?" };
}

export function identityFailure(title: string, error: Failure, what: string): Outcome {
  if (error.kind === 'not_found') return failed(title, 'user_not_found', "I couldn't find your account in Auth0, so I can't check or change it. I can raise a ticket for IT instead.");
  return failed(title, 'identity_unavailable', `I couldn't ${what}: ${describeFailure('Auth0', error)}`);
}

function applyUser(state: SessionState, user: AccountInfo, mode: Mode, now: number) {
  state.account = { ...user, source: mode, checkedAt: now };
}

// The mirror is enough when it came from the same backend; otherwise ask it.
export function currentUser(state: SessionState, identity: IdentityAdapter): Promise<Result<AccountInfo>> {
  const a = state.account;
  if (a.source === identity.mode && a.userId && a.locked !== null) return Promise.resolve(success({ userId: a.userId, email: a.email, locked: a.locked, lastPasswordReset: a.lastPasswordReset, factors: a.factors, factorsKnown: a.factorsKnown }));
  return identity.getUser();
}

const minutesLeft = (state: SessionState, now: number) => Math.max(1, Math.ceil(((state.verification.expiresAt ?? now) - now) / MINUTE));

const verifyIdentity = tool<{ sent: Result<string | null> }>({
  name: 'verifyIdentity',
  description: `Email a six-digit verification code to ${EMPLOYEE.firstName}'s work address. Needed before unlocking the account or resetting the password or MFA. Then ask ${EMPLOYEE.firstName} to read the code and call checkIdentity.`,
  params: {},
  async effect({ state, now, deps }) {
    return isVerified(state, now) ? undefined : { sent: await deps.identity.sendCode() };
  },
  run({ state, now, effect }) {
    if (isVerified(state, now)) return { title: 'Identity already verified', result: ok(`You're already verified for another ${plural(minutesLeft(state, now), 'minute')}.`, { status: 'verified' }) };
    if (!effect) return failed('Verification: try again', 'try_again', 'That did not go through. Please try again.');
    if (!effect.sent.ok) return identityFailure('Verification code not sent', effect.sent.error, 'send the code');
    state.verification = { status: 'pending', sentAt: now, approvedAt: null, expiresAt: null, attempts: 0, checking: [], simulatedCode: effect.sent.value };
    const alert = issueMilestone(state, now, 'waiting_employee', 'Verification code sent to the employee', { title: 'Account access' });
    return { title: 'Verification code emailed', alerts: [alert], result: ok(CODE_SENT_SAY, { status: 'code_sent', expiresInMinutes: CODE_TTL_MS / MINUTE }, `When ${EMPLOYEE.firstName} reads the code, call checkIdentity with it. Never repeat the code.`) };
  },
});

// The digits worth checking with Auth0, or null when the call would be pointless.
function codeToCheck(state: SessionState, raw: string, now: number): string | null {
  const v = state.verification;
  const digits = spokenDigits(raw);
  return verificationStatus(v, now) === 'pending' && v.attempts < MAX_CODE_ATTEMPTS && digits.length === 6 ? digits : null;
}

const checkIdentity = tool<{ sentAt: number | null; checked: Result<boolean> }>({
  name: 'checkIdentity',
  description: `Check the six-digit code ${EMPLOYEE.firstName} reads from the email. Three wrong tries or five minutes without a match need a new code from verifyIdentity.`,
  params: { code: { description: `The code as ${EMPLOYEE.firstName} said it, digits or words, e.g. "421 987" or "four two one nine eight seven"` } },
  // Reserves the attempt before the check, so parallel calls cannot exceed the limit.
  begin(state, args, now, claim) {
    if (!codeToCheck(state, args.code, now)) return false;
    const v = state.verification;
    v.attempts += 1;
    v.checking = [...v.checking, claim];
    return true;
  },
  async effect({ state, deps, claim }, args) {
    const v = state.verification;
    return v.checking.includes(claim) ? { sentAt: v.sentAt, checked: await deps.identity.verifyCode(spokenDigits(args.code)) } : undefined;
  },
  run({ state, now, effect, claim }, args) {
    const v = state.verification;
    const mine = v.checking.includes(claim);
    v.checking = v.checking.filter((c) => c !== claim);
    const status = verificationStatus(v, now);
    if (status === 'approved') return { title: 'Identity already verified', result: ok(`You're verified for another ${plural(minutesLeft(state, now), 'minute')}.`, { status: 'verified' }) };
    if (status === 'none') return failed('Identity check: no code sent', 'not_started', "I haven't sent a code yet. Shall I email you one?");
    if (status === 'failed') return failed('Identity check: too many attempts', 'too_many_attempts', "That code has had three wrong tries, so I'll need to email you a new one.");
    if (status === 'expired') {
      v.status = 'expired';
      v.simulatedCode = null;
      if (v.approvedAt !== null) return failed('Identity check: verification expired', 'verification_expired', "Your verification has expired. I'll need to email you a new code.");
      return failed('Identity check: code expired', 'code_expired', "That code has expired. I'll need to email you a new one.");
    }
    if (spokenDigits(args.code).length !== 6) return failed('Identity check: incomplete code', 'invalid_code', 'I need all six digits from the email. Could you read them again?');
    if (!mine) return failed('Identity check: still checking', 'in_progress', "I'm still checking the code you gave me. One moment.");
    if (!effect || effect.sentAt !== v.sentAt) return failed('Identity check: try again', 'try_again', 'A newer code was sent. Please read me the latest one.');
    if (!effect.checked.ok) {
      // A backend error is not the employee's fault, so the attempt is refunded.
      v.attempts -= 1;
      return identityFailure('Identity check failed', effect.checked.error, 'check the code');
    }
    if (effect.checked.value) {
      state.verification = { status: 'approved', sentAt: v.sentAt, approvedAt: now, expiresAt: now + VERIFICATION_TTL_MS, attempts: v.attempts, checking: [], simulatedCode: null };
      return { title: 'Identity verified by email code', result: ok("Thanks, you're verified for the next 10 minutes.", { status: 'verified', validForMinutes: VERIFICATION_TTL_MS / MINUTE }) };
    }
    const left = MAX_CODE_ATTEMPTS - v.attempts;
    if (left <= 0 && !v.checking.length) {
      v.status = 'failed';
      v.simulatedCode = null;
      return failed('Identity check: wrong code, no tries left', 'too_many_attempts', "That code didn't match, and that was the last try. I'll need to email you a new code.");
    }
    const tries = left > 0 ? ` You have ${plural(left, 'try', 'tries')} left.` : '';
    return failed('Identity check: wrong code', 'wrong_code', `That code didn't match.${tries}`);
  },
});

function accountSay(state: SessionState, now: number) {
  const a = state.account;
  const days = a.lastPasswordReset === null ? null : Math.floor((now - a.lastPasswordReset) / DAY);
  const say = [
    a.locked ? 'Your account is locked after too many failed sign-ins.' : 'Your account is active and not locked.',
    days === null ? '' : `Your password was last reset ${plural(days, 'day')} ago.`,
    !a.factorsKnown ? "I couldn't read your multi-factor methods." : a.factors.length ? 'Multi-factor sign-in is set up.' : 'No multi-factor method is set up.',
  ];
  return { say: say.filter(Boolean).join(' '), data: { locked: a.locked, daysSincePasswordReset: days, mfa: a.factorsKnown ? a.factors : null } };
}

const getAccountStatus = tool<{ mode: Mode; user: Result<AccountInfo> }>({
  name: 'getAccountStatus',
  description: `${EMPLOYEE.firstName}'s account in Auth0: whether it is locked, when the password was last reset, and the multi-factor methods.`,
  params: {},
  minutesSaved: 3,
  async effect({ deps }) {
    return { mode: deps.identity.mode, user: await deps.identity.getUser() };
  },
  run({ state, now, effect }) {
    if (!effect) return failed('Account status: try again', 'try_again', 'That did not go through. Please try again.');
    if (!effect.user.ok) return identityFailure('Account status unavailable', effect.user.error, 'read your account');
    applyUser(state, effect.user.value, effect.mode, now);
    const { say, data } = accountSay(state, now);
    return { title: `Account: ${state.account.locked ? 'locked' : 'active'}`, result: ok(say, data) };
  },
});

const ACTIONS: Record<AccountAction, { summary: string; warnings: string[] }> = {
  unlock: { summary: 'Unlock your Nimbus account', warnings: [] },
  resetPassword: { summary: 'Email a password reset link to your work address', warnings: [] },
  resetMfa: { summary: 'Reset your multi-factor sign-in so you can enrol your new phone', warnings: ['This removes the authenticator from your old phone.'] },
};

const prepareAccountAction = tool<{ mode: Mode; user: Result<AccountInfo> }>({
  name: 'prepareAccountAction',
  description: 'Step 1 of a self-service account fix: unlock, resetPassword (emails a reset link) or resetMfa. Needs a valid verification from checkIdentity. Returns a confirmation code for confirmAction.',
  params: { action: { description: 'unlock, resetPassword or resetMfa', enum: ['unlock', 'resetPassword', 'resetMfa'] } },
  async effect({ state, now, deps }) {
    return isVerified(state, now) ? { mode: deps.identity.mode, user: await deps.identity.getUser() } : undefined;
  },
  run({ state, now, effect }, args) {
    const action = args.action as AccountAction;
    const block = verificationBlock(state, now);
    if (block) return failed(`Account action refused: ${block.error.replace('_', ' ')}`, block.error, block.say);
    if (!effect) return failed('Account action: try again', 'try_again', 'That did not go through. Please try again.');
    if (!effect.user.ok) return identityFailure('Account action: account unavailable', effect.user.error, 'read your account');
    applyUser(state, effect.user.value, effect.mode, now);
    if (action === 'unlock' && !state.account.locked) {
      return failed('Unlock not needed: account not locked', 'not_locked', "Your account isn't locked right now, so there's nothing to unlock. If your password is the problem, I can send a reset link instead.");
    }
    const { summary, warnings } = ACTIONS[action];
    const out = prepare(state, now, { kind: 'account', action }, summary, warnings, `Ready to ${summary.charAt(0).toLowerCase()}${summary.slice(1)}.`);
    return { ...out, alerts: [issueMilestone(state, now, 'waiting_employee', `Waiting for the employee to confirm: ${summary}`, { title: 'Account access' })] };
  },
});

export const lockdownTitle = (what: string) => clip(`Lost or stolen device: ${what}`, 100);

const LOCKDOWN_LEAD =
  "I'll lock everything down right away. Once you say yes, I'll block your account, sign you out on every device, revoke saved sign-ins, reset your multi-factor sign-in, raise an urgent security incident and alert IT security. There's no email code needed for this. Getting back in later needs the usual verification.";

// Protective, so no email code is needed; unlocking afterwards still needs one.
const prepareSecurityLockdown = tool({
  name: 'prepareSecurityLockdown',
  description:
    `Step 1 when ${EMPLOYEE.firstName}'s laptop or phone is lost or stolen: blocks the account, signs ${EMPLOYEE.firstName} out everywhere, revokes saved sign-ins, resets MFA, raises a P1 security incident and alerts IT. No email code needed. Returns a confirmation code for confirmAction.`,
  params: {
    what: { description: 'What happened, in their own words, e.g. "laptop left in an Uber"' },
    when: { description: 'When it happened, e.g. "about an hour ago", or empty string', allowEmpty: true },
  },
  run({ state, now }, args) {
    return prepare(state, now, { kind: 'lockdown', what: args.what, when: args.when }, clip(`Lock down your account: ${args.what}`, 140), [], LOCKDOWN_LEAD);
  },
});

export const IDENTITY_TOOLS = [verifyIdentity, checkIdentity, getAccountStatus, prepareAccountAction, prepareSecurityLockdown];
