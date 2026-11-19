import type { StatusFeed } from '@/lib/integrations/types';

// Services ASK IT can check. Internal ones (no feed) come from the seeded outage list.
interface Service {
  key: string;
  name: string;
  aliases: string[];
  feed: StatusFeed | null;
}

const ATLASSIAN = 'https://status.atlassian.com';
const google = (product: string): StatusFeed => ({ kind: 'google', product });

export const SERVICES: Service[] = [
  { key: 'vpn', name: 'the VPN', aliases: ['vpn', 'globalprotect', 'remote access'], feed: null },
  { key: 'wifi', name: 'the office Wi-Fi', aliases: ['wifi', 'wireless', 'internet', 'network', 'nimbus corp'], feed: null },
  { key: 'outlook', name: 'Outlook and email', aliases: ['outlook', 'email', 'mail', 'exchange', 'calendar'], feed: null },
  { key: 'concur', name: 'SAP Concur', aliases: ['concur', 'sap concur', 'expenses', 'expense'], feed: null },
  { key: 'printers', name: 'the office printers', aliases: ['printer', 'printers', 'printing'], feed: null },
  { key: 'github', name: 'GitHub', aliases: ['github'], feed: { kind: 'statuspage', base: 'https://www.githubstatus.com' } },
  { key: 'jira', name: 'Jira', aliases: ['jira'], feed: { kind: 'statuspage', base: ATLASSIAN, match: 'Jira' } },
  { key: 'confluence', name: 'Confluence', aliases: ['confluence', 'wiki'], feed: { kind: 'statuspage', base: ATLASSIAN, match: 'Confluence' } },
  { key: 'dropbox', name: 'Dropbox', aliases: ['dropbox'], feed: { kind: 'statuspage', base: 'https://status.dropbox.com' } },
  { key: 'figma', name: 'Figma', aliases: ['figma', 'figjam'], feed: { kind: 'statuspage', base: 'https://status.figma.com' } },
  { key: 'chatgpt', name: 'ChatGPT', aliases: ['chatgpt', 'openai'], feed: { kind: 'statuspage', base: 'https://status.openai.com' } },
  { key: 'slack', name: 'Slack', aliases: ['slack'], feed: { kind: 'slack' } },
  { key: 'gmail', name: 'Gmail', aliases: ['gmail', 'google mail'], feed: google('Gmail') },
  { key: 'meet', name: 'Google Meet', aliases: ['google meet', 'meet'], feed: google('Google Meet') },
  { key: 'drive', name: 'Google Drive', aliases: ['google drive', 'drive', 'google docs'], feed: google('Google Drive') },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s: string) => norm(s).replace(/ /g, '');

export function findService(raw: string): Service | undefined {
  const q = squash(raw);
  if (!q) return undefined;
  return SERVICES.find((s) => [s.key, s.name.replace(/^the /i, ''), ...s.aliases].some((a) => squash(a) === q));
}

export const serviceName = (key: string) => SERVICES.find((s) => s.key === key)?.name ?? key;

// Whether free text names a service, by whole words.
export function mentionsService(text: string, key: string): boolean {
  const s = SERVICES.find((x) => x.key === key);
  const hay = ` ${norm(text)} `;
  return Boolean(s && [s.key, ...s.aliases].some((a) => hay.includes(` ${norm(a)} `)));
}
