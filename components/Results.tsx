'use client';

import { Priority, QueueList } from './ItDesk';
import type { StateView } from '@/lib/client/useSessionState';
import { ageLabel, durationLabel, formatHours, formatRate } from '@/lib/client/helpers';
import { timeOfDay } from '@/lib/client/format';

type Board = NonNullable<StateView['itdesk']['board']>;
type Dashboard = Extract<Board, { kind: 'dashboard' }>;
type People = Extract<Board, { kind: 'people' }>;
type Person = People['people'][number];

const SHOWN_TICKETS = 3;
const GROUP_TITLE = { priority: 'By priority', state: 'By state', assignee: 'By assignee', group: 'By group', category: 'By category', opened: 'By day opened' } as const;

function Head({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="wc-result-head">
      <h3>{title}</h3>
      <p>{meta}</p>
    </div>
  );
}

type Row = { label: string; count: number };

// One bar per bucket; the count is printed, the bar only shows proportion, and an empty bucket draws no bar.
// `bad` marks the rows whose bar means trouble, such as Critical.
function BarList({ title, rows, bad = [] }: { title: string; rows: Row[]; bad?: string[] }) {
  const max = Math.max(1, ...rows.map((g) => g.count));
  return (
    <figure className="wc-bars" aria-label={title}>
      <figcaption className="wc-label">{title}</figcaption>
      <ol>
        {rows.map((g) => (
          <li key={g.label} title={`${g.label} ${g.count}`}>
            <span className="min-w-0 truncate">{g.label}</span>
            <span className="wc-bar-track">{g.count ? <span className="wc-bar" data-tone={bad.includes(g.label) ? 'bad' : undefined} style={{ width: `${(g.count / max) * 100}%` }} /> : null}</span>
            <span className="wc-num text-right">{g.count}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

const STATE_TONE: Record<string, string | undefined> = { New: 'muted', 'In Progress': 'info', 'On Hold': 'warn' };

// Open work split by state in one bar; the legend carries the numbers.
function StateBar({ rows }: { rows: Row[] }) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  return (
    <figure className="wc-stack" aria-label="Open by state">
      <figcaption className="wc-label">Open by state</figcaption>
      <div className="wc-stack-bar" aria-hidden="true">
        {total ? rows.filter((r) => r.count).map((r) => <span key={r.label} data-tone={STATE_TONE[r.label]} style={{ flexGrow: r.count }} title={`${r.label} ${r.count}`} />) : null}
      </div>
      <ul className="wc-legend">
        {rows.map((r) => (
          <li key={r.label}><span className="wc-key" data-tone={STATE_TONE[r.label]} aria-hidden="true" />{r.label}<span className="wc-num">{r.count}</span></li>
        ))}
      </ul>
    </figure>
  );
}

// New and resolved incidents per day, oldest on the left; the legend carries the week totals.
function DayColumns({ days }: { days: Dashboard['days'] }) {
  const max = Math.max(1, ...days.flatMap((d) => [d.opened, d.resolved]));
  const sum = (key: 'opened' | 'resolved') => days.reduce((n, d) => n + d[key], 0);
  return (
    <figure className="wc-columns" aria-label="New and resolved incidents per day, last 7 days">
      <figcaption className="wc-label">Last 7 days</figcaption>
      <ul className="wc-legend">
        <li><span className="wc-key" data-tone="info" aria-hidden="true" />New<span className="wc-num">{sum('opened')}</span></li>
        <li><span className="wc-key" data-tone="muted" aria-hidden="true" />Resolved<span className="wc-num">{sum('resolved')}</span></li>
      </ul>
      <ol>
        {days.map((d) => (
          <li key={d.label} title={`${d.label} ${d.opened} new ${d.resolved} resolved`} aria-label={`${d.label}, ${d.opened} new, ${d.resolved} resolved`}>
            <span className="wc-column-track">
              <span className="wc-column" data-empty={!d.opened} style={{ height: `${(d.opened / max) * 100}%` }} />
              <span className="wc-column" data-tone="muted" data-empty={!d.resolved} style={{ height: `${(d.resolved / max) * 100}%` }} />
            </span>
            <span className="wc-column-day">{d.label.split(' ')[0]}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

type Stat = { value: string; label: string; sub?: string; tone?: 'bad' | 'warn' };

function Stats({ stats, label }: { stats: Stat[]; label: string }) {
  return (
    <ul className="wc-stats" aria-label={label}>
      {stats.map((t) => (
        <li key={t.label} data-tone={t.tone}>
          <span className="wc-stat-label">{t.tone ? <span className="wc-dot" aria-hidden="true" /> : null}{t.label}</span>
          <strong>{t.value}</strong>
          {t.sub ? <span className="wc-stat-sub">{t.sub}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// Secondary numbers on one quiet line under the headline tiles.
function Facts({ facts }: { facts: { label: string; value: string; sub?: string }[] }) {
  return (
    <dl className="wc-facts" aria-label="Flow">
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd>{f.value}{f.sub ? <small>{f.sub}</small> : null}</dd>
        </div>
      ))}
    </dl>
  );
}

function DashboardView({ d, now }: { d: Dashboard; now: number }) {
  const n = (v: number) => String(v);
  const headline: Stat[] = [
    { value: d.more ? `${d.total}+` : n(d.total), label: 'Open incidents', sub: `${d.inProgress} in progress` },
    { value: n(d.critical), label: 'Critical', tone: d.critical ? 'bad' : undefined },
    { value: n(d.unassigned), label: 'Unassigned', tone: d.unassigned ? 'warn' : undefined },
    { value: n(d.onHold), label: 'On hold', sub: 'Blocked', tone: d.onHold ? 'warn' : undefined },
  ];
  const facts = [
    { label: 'New today', value: n(d.openedToday) },
    { label: 'Resolved today', value: n(d.resolvedToday) },
    { label: 'Resolved in 7 days', value: n(d.resolvedWeek) },
    { label: 'Avg time to resolve', value: d.avgResolve ? durationLabel(d.avgResolve.ms) : 'None' },
    { label: 'Oldest open', value: d.oldest ? ageLabel(d.oldest.openedAt, now) : 'None', sub: d.oldest?.number },
  ];
  return (
    <div className="wc-dash">
      <Stats stats={headline} label="Open queue" />
      <Facts facts={facts} />
      <div className="wc-dash-grid">
        <section className="wc-panel">
          <BarList title="Open by priority" rows={d.byPriority} bad={['Critical']} />
          <StateBar rows={d.byState} />
        </section>
        <section className="wc-panel">
          <BarList title="Open by team" rows={d.byTeam} />
        </section>
        <section className="wc-panel">
          <DayColumns days={d.days} />
        </section>
      </div>
    </div>
  );
}

function Impact({ k }: { k: StateView['kpis'] }) {
  const tiles: [string, string, string][] = [
    [String(k.resolvedByAgent), 'Fixed on the call', 'Issues ASK IT solved without a ticket'],
    [formatRate(k.deflectionRate), 'Deflection', 'Handled without a new ticket'],
    [String(k.duplicatesAvoided), 'Duplicates avoided', 'Callers added to a known outage'],
    [String(k.ticketsRaised), 'Tickets raised', 'Only after a guided fix failed'],
    [String(k.ticketsUpdatedByVoice), 'Updated by voice', 'ServiceNow incidents changed from this desk'],
    [formatHours(k.minutesSaved), 'Hours saved', `Estimated from ${k.toolCalls} actions`],
  ];
  return (
    <ul className="wc-impact">
      {tiles.map(([value, label, hint]) => (
        <li key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
          <small>{hint}</small>
        </li>
      ))}
    </ul>
  );
}

const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

function Status({ person }: { person: Person }) {
  const n = person.open.length;
  return (
    <span className="wc-chip wc-person-status" data-tone={n ? 'warn' : 'ok'}>
      <span className="wc-dot" aria-hidden="true" />
      {n ? `Busy · ${n} ${n === 1 ? 'ticket' : 'tickets'}` : 'Available'}
    </span>
  );
}

function Teams({ teams }: { teams: string[] }) {
  return <span className="wc-teams">{teams.map((t) => <span key={t} className="wc-chip" title={t}>{t}</span>)}</span>;
}

// One row per person: who, which teams, free or busy, and the tickets keeping them busy.
function PeopleList({ board }: { board: People }) {
  if (!board.people.length) {
    return <p className="wc-result-none">{board.available + board.busy ? 'Nobody here has an open ticket right now.' : 'Nobody active in this team.'}</p>;
  }
  return (
    <ul className="wc-people" aria-live="polite">
      {board.people.map((p, n) => (
        <li key={`${p.name}-${n}`}>
          <span className="wc-avatar" aria-hidden="true">{initials(p.name)}</span>
          <span className="wc-person-cell">
            <strong className="truncate" title={p.name}>{p.name}</strong>
            <Teams teams={p.teams} />
          </span>
          <Status person={p} />
          {p.open.length ? (
            <span className="wc-people-tickets" title={p.open.map((t) => `${t.number} ${t.summary}`).join('\n')}>
              {p.open.slice(0, SHOWN_TICKETS).map((t) => <span key={t.number} className="wc-mono">{t.number}</span>)}
              {p.open.length > SHOWN_TICKETS ? <span className="wc-faint">+{p.open.length - SHOWN_TICKETS} more</span> : null}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PersonDetail({ person, asOf }: { person: Person; asOf: string }) {
  return (
    <>
      <div className="wc-person-head">
        <span className="wc-avatar" data-size="lg" aria-hidden="true">{initials(person.name)}</span>
        <div className="wc-person-cell">
          <h3 className="truncate" title={person.name}>{person.name}</h3>
          <Teams teams={person.teams} />
        </div>
        <Status person={person} />
      </div>
      {person.open.length ? (
        <ul className="wc-person-open" aria-label="Open tickets">
          {person.open.map((t) => (
            <li key={t.number}>
              <span className="wc-mono text-[12px]">{t.number}</span>
              <span className="min-w-0 truncate" title={t.summary}>{t.summary}</span>
              <Priority incident={t} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="wc-muted">No open tickets, free to take new work.</p>
      )}
      <p className="wc-person-hint"><span className="min-w-0 truncate">Say <q>assign it to {person.name.split(' ')[0]}</q></span><span className="wc-faint ml-auto whitespace-nowrap text-[12px]">{asOf}</span></p>
    </>
  );
}

// The answer to the engineer's last question, and nothing else.
export function Results({ view, now }: { view: StateView; now: number }) {
  const board = view.itdesk.board;
  if (!board) return null;
  const asOf = `as of ${timeOfDay('syncedAt' in board && board.syncedAt ? board.syncedAt : board.at)}`;
  if (board.kind === 'impact') {
    return (
      <section key={board.at} className="wc-result wc-enter" aria-label="ASK IT impact">
        <Head title="What ASK IT has done" meta={`This session · ${asOf}`} />
        <Impact k={view.kpis} />
      </section>
    );
  }
  if (board.kind === 'people') {
    return (
      <section key={board.at} className="wc-result wc-enter" aria-label={`People in ${board.title}`}>
        <Head title={board.title} meta={`${board.available} available · ${board.busy} busy · ${asOf}`} />
        <PeopleList board={board} />
      </section>
    );
  }
  if (board.kind === 'person') {
    return (
      <section key={board.at} className="wc-result wc-enter" aria-label={board.person.name}>
        <PersonDetail person={board.person} asOf={asOf} />
      </section>
    );
  }
  if (board.kind === 'dashboard') {
    return (
      <section key={board.at} className="wc-result wc-enter" aria-label="Service desk dashboard">
        <Head title="Service desk overview" meta={`${view.integrations.tickets === 'live' ? 'Live from ServiceNow' : 'Simulated ServiceNow'} · ${asOf}`} />
        <DashboardView d={board} now={now} />
      </section>
    );
  }
  const unit = board.total === 1 && !board.more ? 'incident' : 'incidents';
  const total = board.more ? `${board.total}+` : String(board.total);
  if (board.kind === 'count') {
    return (
      <section key={board.at} className="wc-result wc-enter" aria-label={board.title}>
        <Head title={board.title} meta={asOf} />
        <div className="wc-count-view" data-split={board.groups.length > 0}>
          <p className="wc-hero"><strong>{total}</strong><span>{unit}</span></p>
          {board.groups.length ? <BarList title={GROUP_TITLE[board.groupBy!]} rows={board.groups} /> : null}
        </div>
      </section>
    );
  }
  return (
    <section key={board.at} className="wc-result wc-enter" aria-label={board.title}>
      <Head title={board.title} meta={`${total} ${unit}${board.more ? ` · showing the first ${board.total}` : ''} · ${asOf}`} />
      {board.total ? (
        <QueueList queue={view.itdesk.queue} current={view.itdesk.current?.number ?? null} now={now} />
      ) : (
        <p className="wc-result-none">Nothing matches. Try a wider filter, such as this week instead of today.</p>
      )}
    </section>
  );
}
