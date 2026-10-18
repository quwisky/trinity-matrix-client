/**
 * Whether `url` is part of the Matrix server named `server` (a server name such as
 * `matrix.org` or `localhost:8450`): its hostname equals that host or is a subdomain of
 * it. Letter case, a trailing dot and ports do not count; anything unparseable is not part.
 */
export function isPartOfServer(url: string, server: string): boolean {
  const host = hostnameOf(url);
  const serverHost = hostnameOf(`https://${server.replace(/^\/+/, '')}`);
  return (
    !!host &&
    !!serverHost &&
    (host === serverHost || host.endsWith(`.${serverHost}`))
  );
}

/** The lowercased, punycoded hostname without a trailing dot, or null. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}
