/**
 * The server name in what someone typed as their server: `@user:server.org`,
 * `user:server.org`, `server.org` or `server.org:8448`. A colon followed only by digits
 * is a port, so the input is the server name as typed.
 */
export function serverNameOfInput(input: string): string {
  const trimmed = input.trim().replace(/^@/, '');
  const colon = trimmed.indexOf(':');
  if (colon < 0 || /^\d+$/.test(trimmed.slice(colon + 1))) return trimmed;
  return trimmed.slice(colon + 1);
}
