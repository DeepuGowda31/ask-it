import { Brand } from './Brand';

// Shown instead of the app when required environment variables are missing (names only, never values).
export function SetupScreen({ missing }: { missing: string[] }) {
  return (
    <div className="min-h-dvh">
      <header className="wc-header"><Brand subtitle="Setup required" /></header>
      <main id="main-content" className="mx-auto grid max-w-[720px] gap-5 px-4 py-10 md:px-10">
        <h2 className="text-[36px] font-normal leading-[44px] tracking-tight">Finish setting up ASK IT</h2>
        <p className="wc-lead">The server is missing these environment variables. Add them to <code className="wc-mono">.env.local</code> (local) or your Vercel project settings, then restart.</p>
        <ul className="grid gap-2">
          {missing.map((name) => (
            <li key={name} className="wc-mono text-[14px]"><span className="wc-tone-bad" aria-hidden="true">● </span>{name}</li>
          ))}
        </ul>
        <p className="wc-note">See <code className="wc-mono">env.local.example</code> and the README for what each one does. For live voice calls you also need a public HTTPS URL (PUBLIC_BASE_URL, or a Vercel deployment).</p>
      </main>
    </div>
  );
}
