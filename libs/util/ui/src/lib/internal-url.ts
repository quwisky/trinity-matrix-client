/**
 * Resolve a caller-supplied `returnTo` to a safe in-app path. Only same-origin
 * absolute paths are honored; protocol-relative (`//host`) and backslash (`/\`)
 * forms are rejected so a crafted value can't redirect off-app. Anything else
 * falls back to `/rooms` (or the given `fallback`). Single-sourced here because
 * several flows (encryption unlock, device verification) share the check.
 */
export function resolveInternalReturnTo(
  returnTo: string | null | undefined,
  fallback = '/rooms',
): string {
  const internal =
    !!returnTo &&
    returnTo.startsWith('/') &&
    !returnTo.startsWith('//') &&
    !returnTo.startsWith('/\\');
  return internal ? returnTo : fallback;
}
