import Link from 'next/link';

function BrandMark() {
  return (
    <svg className="wc-brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="none" stroke="var(--hairline-strong)" />
      <path d="M8 20v-8M12 23V9M16 19v-6M20 22V10M24 18v-4" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({ subtitle, href = '/' }: { subtitle: string; href?: string }) {
  return (
    <Link className="wc-brand" href={href} aria-label="ASK IT home">
      <BrandMark />
      <span>
        <h1>ASK IT</h1>
        <p>{subtitle}</p>
      </span>
    </Link>
  );
}
