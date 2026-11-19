'use client';

import { Priority, QueueList } from './ItDesk';
import type { StateView } from '@/lib/client/useSessionState';
import { formatHours, formatRate } from '@/lib/client/helpers';
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
function BarList({ title, rows }: { title: string; rows: Row[] }) {
  const max = Math.max(1, ...rows.map((g) => g.count));
  return (
    <figure className="wc-bars" aria-label={title}>
      <figcaption className="wc-label">{title}</figcaption>
      <ol>
        {rows.map((g) => (
          <li key={g.label} title={`${g.label}: ${g.count}`}>
            <span className="min-w-0 truncate">{g.label}</span>
            <span className="wc-bar-track">{g.count ? <span className="wc-bar" style={{ width: `${(g.count / max) * 100}%` }} /> : null}</span>
            <span className="wc-num text-right">{g.count}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

// New incidents per day as columns, oldest on the left.
function DayColumns({ days }: { days: Dashboard['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.opened));
  return (
    <figure className="wc-columns" aria-label="New incidents per day, last 7 days">
      <figcaption className="wc-label">New incidents per day</figcaption>
      <ol>
        {days.map((d) => (
          <li key={d.label} title={`${d.label}: ${d.opened} new`}>
            <span className="wc-num">{d.opened}</span>
            <span className="wc-column-track">{d.opened ? <span className="wc-column" style={{ height: `${(d.opened / max) * 100}%` }} /> : null}</span>
            <span className="wc-column-day">{d.label}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function DashboardView({ d }: { d: Dashboard }) {
  const tiles: { value: string; label: string; tone?: 'bad' | 'warn' }[] = [
    { value: d.more ? `${d.total}+` : String(d.total), label: 'Open incidents' },
    { value: String(d.critical), label: 'Critical', tone: d.critical ? 'bad' : undefined },
    { value: String(d.unassigned), label: 'Unassigned', tone: d.unassigned ? 'warn' : undefined },
    { value: String(d.openedToday), label: 'New today' },
    { value: String(d.resolvedWeek), label: 'Resolved, last 7 days' },
  ];
  return (
    <div className="wc-dash">
      <ul className="wc-dash-tiles">
        {tiles.map((t) => (
          <li key={t.label}>
            <strong>{t.value}</strong>
            <span className="wc-status" data-tone={t.tone}>{t.tone ? <span className="wc-dot" aria-hidden="true" /> : null}{t.label}</span>
          </li>
        ))}
      </ul>
      <div className="wc-dash-grid">
        <div className="wc-dash-col">
          <BarList title="Open by priority" rows={d.byPriority} />
          <DayColumns days={d.days} />
        </div>
        <BarList title="Open by team" rows={d.byTeam} />
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
        <p className="wc-muted">No open tickets: free to take new work.</p>
      )}
      <p className="wc-person-hint"><span className="min-w-0 truncate">Say: <q>assign it to {person.name.split(' ')[0]}</q></span><span className="wc-faint ml-auto whitespace-nowrap text-[12px]">{asOf}</span></p>
    </>
  );
}

// The answer to the engineer's last question, and nothing else.
export function Results({ view, now }: { view: StateView; now: number }) {
  const board = view.itdesk.board;
  if (!board) return null;
  const asOf = `as of ${timeOfDay(board.at)}`;
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
        <DashboardView d={board} />
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
