import EmployeeApp from '@/components/EmployeeApp';
import { SetupScreen } from '@/components/SetupScreen';
import { missingEnv, resolvePublicBaseUrl } from '@/lib/agent/config';
import { usingSharedStore } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export default function EmployeePage() {
  const missing = missingEnv();
  if (missing.length) return <SetupScreen missing={missing} />;
  const base = resolvePublicBaseUrl();
  let warning = base.ok ? null : `Voice calls are disabled until this is fixed: ${base.reason}`;
  if (!warning && process.env.VERCEL && !usingSharedStore()) {
    warning = 'This deployment has no Redis store configured (UPSTASH_REDIS_REST_URL / KV_REST_API_URL), so serverless instances will not share session state.';
  }
  return <EmployeeApp setupWarning={warning} />;
}
