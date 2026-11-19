const CODE_RE = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;

// The session a page should open: the one in its link, else the last one used in this browser.
export function pickSessionCode(fromUrl: string | null, stored: string | null): string | null {
  const url = (fromUrl ?? '').trim().toUpperCase();
  if (CODE_RE.test(url)) return url;
  const kept = (stored ?? '').trim().toUpperCase();
  return CODE_RE.test(kept) ? kept : null;
}
