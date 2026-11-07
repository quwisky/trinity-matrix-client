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
  name = name.slice(name.lastIndexOf('@') + 1);
  // The server-name colon comes first: a localpart may hold a `/` (`@a/b:example.org`).
  const colon = name.startsWith('[') ? -1 : name.indexOf(':');
  if (colon >= 0 && !/^\d+$/.test(withoutPath(name.slice(colon + 1)))) {
    name = name.slice(colon + 1);
  }
  return withoutPath(name);
}

function withoutPath(name: string): string {
  return name.split('/')[0];
}
