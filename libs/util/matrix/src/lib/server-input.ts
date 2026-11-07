/**
 * The server name in what someone typed as their server: `@user:server.org`,
 * `user:server.org`, `server.org`, `server.org:8448`, `[::1]:8448` or an `https://` URL.
 * A colon followed only by digits is a port, so the input is the server name as typed.
 */
export function serverNameOfInput(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).host;
    } catch {
      // Not a URL after all: read it as typed.
    }
  }
  let name = trimmed.replace(/^@/, '');
  // Credentials (`user:pass@host`) or an address-like `user@host`: the server follows the @.
  name = name.slice(name.lastIndexOf('@') + 1).split('/')[0];
  if (name.startsWith('[')) return name;
  const colon = name.indexOf(':');
  if (colon < 0 || /^\d+$/.test(name.slice(colon + 1))) return name;
  return name.slice(colon + 1);
}
