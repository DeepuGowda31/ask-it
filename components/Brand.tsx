import Link from 'next/link';

// 24-unit line icons: a support headset for the employee app, a person at a computer for IT Operations.
const MARKS = {
  helpdesk: (
    <>
      <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z" />
      <path d="M21 16v2a4 4 0 0 1-4 4h-5" />
    </>
  ),
  operations: (
    <>
      <rect x="12.5" y="3" width="9.5" height="7.5" rx="1.5" />
      <path d="M17.25 10.5V14M10 14h12" />
      <circle cx="5.5" cy="5.5" r="2.5" />
      <path d="M3.5 21v-7.5A2.5 2.5 0 0 1 6 11h.5a2 2 0 0 1 1.7.95L10 14M3.5 18H8l1.5 3" />
    </>
  ),
};

type Mark = keyof typeof MARKS;

export function BrandMark({ mark = 'helpdesk', className = 'wc-brand-mark' }: { mark?: Mark; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="var(--accent-soft)" stroke="var(--accent-line)" />
      <g transform="translate(6.4 6.4) scale(0.8)" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {MARKS[mark]}
      </g>
    </svg>
  );
}

export function Brand({ subtitle, href = '/', mark }: { subtitle: string; href?: string; mark?: Mark }) {
  return (
    <Link className="wc-brand" href={href} aria-label="ASK IT home">
      <BrandMark mark={mark} />
      <span>
        <h1>ASK IT</h1>
        <p>{subtitle}</p>
      </span>
    </Link>
  );
}
