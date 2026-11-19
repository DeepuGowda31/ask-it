import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time comparison of the x-tool-secret header; fails closed when no secret is configured.
export function isAuthorizedToolCall(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export const TOOL_SECRET_HEADER = 'x-tool-secret';
