import { describe, expect, it } from 'vitest';
import { ARTICLES, findArticle } from '@/lib/domain/kb';
import { confident, rankKnowledge, searchKnowledge } from '@/lib/domain/search';
import { CATEGORIES } from '@/lib/domain/queue-query';
import { SERVICES, findService } from '@/lib/domain/services';
import { findTicket, nextSimNumber, parseTicketNumber, spokenTicket } from '@/lib/domain/tickets';
import { NOW, freshState } from './helpers';

describe('knowledge base', () => {
  it('has about 35 short guides with one spoken sentence and a yes or no check per step', () => {
    expect(ARTICLES.length).toBeGreaterThanOrEqual(32);
    expect(ARTICLES.length).toBeLessThanOrEqual(40);
    expect(new Set(ARTICLES.map((a) => a.id)).size).toBe(ARTICLES.length);
    for (const a of ARTICLES) {
      expect(a.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(CATEGORIES).toContain(a.category);
      if (a.service) expect(SERVICES.map((s) => s.key)).toContain(a.service);
      expect(a.steps.length).toBeGreaterThanOrEqual(3);
      expect(a.steps.length).toBeLessThanOrEqual(5);
      for (const s of a.steps) {
        expect(s.text).toMatch(/[.!]$/);
        expect(s.text, 'one sentence').not.toMatch(/[.!?] [A-Z]/);
        expect(s.check).toMatch(/^(Is|Are|Does|Do|Did|Can|Could|Has|Have|Shall|Was|Were) [^?]+\?$/);
        expect(`${s.text} ${s.check}`).not.toMatch(/[*#`_[\](){}]|System Preferences/);
      }
    }
  });
  it('keeps the original guide ids', () => {
    for (const id of ['vpn', 'wifi', 'outlook', 'password', 'mfa-new-phone', 'printer', 'slow-laptop', 'meeting-audio', 'software-request', 'disk-full']) expect(findArticle(id)?.id).toBe(id);
    expect(findArticle('vpn')?.steps).toHaveLength(5);
    expect(findArticle('mfa-new-phone')?.steps).toHaveLength(3);
  });
  it('marks requests, which end in a ticket rather than a fix', () => {
    const requests = ARTICLES.filter((a) => a.request).map((a) => a.id).sort();
    expect(requests).toEqual(['access-request', 'hardware-request', 'software-request']);
    expect(findArticle('hardware-request')?.category).toBe('hardware');
    expect(findArticle('software-request')?.category).toBe('software');
  });
  it('finds articles by id, loosely spoken', () => {
    expect(findArticle('vpn')?.title).toMatch(/GlobalProtect/);
    expect(findArticle(' VPN ')?.id).toBe('vpn');
    expect(findArticle('disk full')?.id).toBe('disk-full');
    expect(findArticle('quantum router')).toBeUndefined();
  });
});

describe('BM25 search', () => {
  it.each([
    ['my vpn keeps disconnecting', 'vpn'],
    ['GlobalProtect will not connect', 'vpn'],
    ['wi-fi in the office is not working', 'wifi'],
    ['outlook is not getting new email', 'outlook'],
    ['I am locked out of my account', 'password'],
    ['got a new phone, need to set up my authenticator', 'mfa-new-phone'],
    ['cannot print', 'printer'],
    ['laptop is really slow', 'slow-laptop'],
    ['zoom microphone not working', 'meeting-audio'],
    ['need to install Tableau', 'software-request'],
    ['my disk is full', 'disk-full'],
    ["my external monitor isn't detected", 'external-monitor'],
    ['the second screen stays black when I plug it in', 'external-monitor'],
    ["outlook isn't syncing", 'outlook'],
    ['my emails are stuck in the outbox', 'outlook-send-receive'],
    ["zoom can't hear me", 'meeting-audio'],
    ['nobody can hear me on teams', 'meeting-audio'],
    ['my camera is not working in zoom', 'meeting-video'],
    ["I can't share my screen in teams", 'screen-sharing'],
    ['laptop is super slow', 'slow-laptop'],
    ['disk is full', 'disk-full'],
    ['my mac says startup disk almost full', 'disk-full'],
    ['I think I got a phishing email', 'phishing'],
    ['I clicked a link in a suspicious email', 'phishing'],
    ['need adobe acrobat installed', 'software-request'],
    ['can you install visual studio code for me', 'software-request'],
    ['I need a new laptop charger', 'hardware-request'],
    ['I need access to the finance shared drive', 'access-request'],
    ["sharepoint says I don't have access", 'sharepoint-access'],
    ['my bluetooth mouse keeps disconnecting', 'bluetooth'],
    ['keyboard not pairing', 'bluetooth'],
    ['the usb-c dock is not working', 'dock-usb-c'],
    ['my external webcam is not detected', 'external-webcam'],
    ['excel is frozen and not responding', 'app-frozen'],
    ['the fan is really loud and the laptop is hot', 'fan-heat'],
    ['battery drains really fast', 'battery-drain'],
    ['laptop is not charging', 'battery-drain'],
    ['the sign in page keeps looping', 'sso-loop'],
    ['my password expires in three days, how do I change it', 'password-change'],
    ['got an alert about a sign in from another country', 'suspicious-login'],
    ['hotel wifi login page does not show up', 'dns-captive-portal'],
    ['websites will not load but wifi is connected', 'dns-captive-portal'],
    ['word says unlicensed product', 'licence-activation'],
    ['office keeps asking me to activate', 'licence-activation'],
    ['website looks broken, maybe clear cache and cookies', 'browser-cache'],
    ['onedrive is not syncing my files', 'onedrive-sync'],
    ['how do I share my calendar with my manager', 'outlook-sharing'],
    ['the team shared mailbox disappeared from outlook', 'shared-mailbox'],
    ['not getting slack notifications', 'notifications'],
    ['slack is stuck connecting', 'slack-not-loading'],
  ])('"%s" → %s', (query, id) => {
    expect(searchKnowledge(query)[0]?.id).toBe(id);
  });
  it.each([
    'vpn',
    'outlook',
    'my vpn keeps disconnecting',
    "my external monitor isn't detected",
    'I think I got a phishing email',
    'got an alert about a sign in from another country',
    'nobody can hear me on teams',
    'laptop is not charging',
    'I need access to the finance shared drive',
  ])('trusts the local guide for "%s"', (query) => {
    expect(confident(rankKnowledge(query)[0])).toBe(true);
  });
  it.each([
    'how do I submit an expense report in concur',
    'how do I set up an email signature',
    'how do I book a meeting room',
    'how do I set up out of office reply',
    'excel macro error',
    'my laptop screen is cracked',
    'docker desktop will not start',
    'how do I get a parking pass',
  ])('asks ServiceNow too for "%s"', (query) => {
    expect(confident(rankKnowledge(query)[0])).toBe(false);
  });
  it('returns nothing for noise', () => {
    expect(searchKnowledge('the and of')).toEqual([]);
    expect(searchKnowledge('banana smoothie recipe')).toEqual([]);
  });
});

describe('service catalog', () => {
  it('resolves names and spoken aliases', () => {
    expect(findService('VPN')?.key).toBe('vpn');
    expect(findService('global protect')?.key).toBe('vpn');
    expect(findService('Wi-Fi')?.key).toBe('wifi');
    expect(findService('SAP Concur')?.key).toBe('concur');
    expect(findService('git hub')?.key).toBe('github');
    expect(findService('google meet')?.key).toBe('meet');
    expect(findService('Chat GPT')?.key).toBe('chatgpt');
    expect(findService('email')?.key).toBe('outlook');
    expect(findService('mainframe')).toBeUndefined();
    expect(findService('')).toBeUndefined();
  });
  it('marks internal systems without a public feed', () => {
    const internal = SERVICES.filter((s) => !s.feed).map((s) => s.key).sort();
    expect(internal).toEqual(['concur', 'outlook', 'printers', 'vpn', 'wifi']);
  });
});

describe('ticket numbers', () => {
  it.each([
    ['INC0012001', 'INC0012001'],
    ['inc0012001', 'INC0012001'],
    ['I N C 12001', 'INC0012001'],
    ['I-N-C one two zero zero one', 'INC0012001'],
    ['ticket 12001', 'INC0012001'],
    ['12001', 'INC0012001'],
    ['INC 001 1994', 'INC0011994'],
  ])('reads "%s"', (raw, number) => {
    expect(parseTicketNumber(raw)).toBe(number);
  });
  it('rejects things that are not ticket numbers', () => {
    expect(parseTicketNumber('my vpn ticket')).toBeNull();
    expect(parseTicketNumber('123456789')).toBeNull();
  });
  it('speaks numbers letter by letter without leading zeros', () => {
    expect(spokenTicket('INC0012001')).toBe('I-N-C one two zero zero one');
    expect(spokenTicket('INC0011950')).toBe('I-N-C one one nine five zero');
    expect(spokenTicket('LOCAL-7')).toBe('local reference seven');
  });
  it('finds a mirrored ticket by spoken number, or the latest open one', () => {
    const s = freshState();
    expect(findTicket(s, 'ticket 11994')?.number).toBe('INC0011994');
    expect(findTicket(s, 'I N C 1 1 9 8 7')?.number).toBe('INC0011987');
    expect(findTicket(s, '')?.number).toBe('INC0011994');
    expect(findTicket(s, 'latest')?.number).toBe('INC0011994');
    expect(findTicket(s, 'INC0099999')).toBeUndefined();
  });
  it('allocates simulated numbers from INC0012001', () => {
    const s = freshState();
    expect(nextSimNumber(s)).toBe('INC0012001');
    s.tickets.push({ ...s.tickets[0], number: 'INC0012001', source: 'simulated' });
    expect(nextSimNumber(s)).toBe('INC0012002');
  });
});

describe('seed', () => {
  it('is Deepak at Nimbus Labs with a locked account, two earlier tickets and the Concur outage', () => {
    const s = freshState();
    expect(s.employee).toMatchObject({ name: 'Deepak Gowda', device: { id: 'NB-2231', model: 'MacBook Pro', os: 'macOS 15' }, vpnClient: 'GlobalProtect' });
    expect(s.account).toMatchObject({ email: 'deepak.gowda@nimbuslabs.example', locked: true, source: 'simulated', factors: ['otp'], factorsKnown: true });
    expect(s.verification).toEqual({ status: 'none', sentAt: null, approvedAt: null, expiresAt: null, attempts: 0, checking: [], simulatedCode: null });
    expect(s.lastResolution).toBeNull();
    expect(s.tickets.map((t) => [t.number, t.state])).toEqual([
      ['INC0011994', 'In Progress'],
      ['INC0011987', 'Resolved'],
    ]);
    expect(s.outages).toEqual([expect.objectContaining({ service: 'concur', incident: 'INC0011950', affected: 14, followed: false })]);
    expect(s.outages.some((o) => o.service === 'vpn')).toBe(false);
    expect(s.metrics).toEqual({ resolvedByAgent: 0, ticketsRaised: 0, duplicatesAvoided: 0, accountActions: 0, ticketsUpdatedByVoice: 0, minutesSaved: 0 });
    expect(freshState(NOW)).toEqual(s);
  });
});

describe('seed in live ticket mode', () => {
  it('has no simulated tickets or outage; a real outage is read from ServiceNow later', () => {
    const s = freshState(NOW, { tickets: 'live' });
    expect(s.tickets).toEqual([]);
    expect(s.outages).toEqual([]);
  });
});

describe('home and office internet guides', () => {
  const top = (q: string) => rankKnowledge(q)[0]?.article.id;
  it.each([
    'internet not working at home',
    'not able to connect to the internet, working from home on my hotspot',
    'home wifi has no internet',
    'phone hotspot connected but no internet',
  ])('finds the home guide for %j', (q) => {
    expect(top(q)).toBe('home-internet');
  });
  it.each(['office wifi not connecting', 'cannot join Nimbus-Corp wifi in the office'])('keeps the office guide for %j', (q) => {
    expect(top(q)).toBe('wifi');
  });
});
