import { describe, expect, it } from 'vitest';
import {
  GATEWAY_NOTIFY_PATH,
  normalizeGatewayUrl,
  type GatewayUrlProblem,
} from './push-gateway-url';

const NOTIFY = `https://push.example.org${GATEWAY_NOTIFY_PATH}`;

describe('normalizeGatewayUrl', () => {
  describe('accepts and canonicalises', () => {
    // Each row was checked against Synapse: the `expected` column is a URL it accepts
    // on POST /pushers/set, and every `input` that differs from it is a shape Synapse
    // itself rejects (400 M_MISSING_PARAM) but a person plausibly types.
    const cases: readonly [string, string, string][] = [
      ['the canonical form unchanged', NOTIFY, NOTIFY],
      ['a bare origin', 'https://push.example.org', NOTIFY],
      [
        'a bare origin with a trailing slash',
        'https://push.example.org/',
        NOTIFY,
      ],
      ['a trailing slash on the notify path', `${NOTIFY}/`, NOTIFY],
      ['surrounding whitespace', `  ${NOTIFY}  `, NOTIFY],
      [
        'a port',
        'https://push.example.org:8448',
        `https://push.example.org:8448${GATEWAY_NOTIFY_PATH}`,
      ],
    ];

    for (const [label, input, expected] of cases) {
      it(label, () => {
        const result = normalizeGatewayUrl(input);
        expect(result.ok).toBe(true);
        expect(result.ok && result.url).toBe(expected);
      });
    }

    it('drops a fragment but keeps a query string', () => {
      // Synapse accepts a query (multi-tenant gateways key on it); a fragment is
      // meaningless to a server-to-server POST and would otherwise be sent verbatim.
      const result = normalizeGatewayUrl(`${NOTIFY}?tenant=a#section`);
      expect(result.ok && result.url).toBe(`${NOTIFY}?tenant=a`);
    });
  });

  describe('rejects', () => {
    const cases: readonly [string, string, GatewayUrlProblem][] = [
      ['an empty string', '', 'empty'],
      ['whitespace only', '   ', 'empty'],
      ['a non-URL', 'not a url', 'malformed'],
      ['a relative URL', 'push.example.org/notify', 'malformed'],
      ['a javascript: scheme', 'javascript:alert(1)', 'unsupported-scheme'],
      ['a data: scheme', 'data:text/plain,hi', 'unsupported-scheme'],
      ['a matrix: scheme', 'matrix:u/alice:example.org', 'unsupported-scheme'],
      [
        'embedded credentials',
        'https://user:pw@push.example.org',
        'embedded-credentials',
      ],
      [
        'a username alone',
        'https://user@push.example.org',
        'embedded-credentials',
      ],
      ['an unrelated path', 'https://push.example.org/push', 'wrong-path'],
      [
        'the notify path under a prefix',
        'https://push.example.org/gw/_matrix/push/v1/notify',
        'wrong-path',
      ],
      [
        'an over-long input',
        `https://push.example.org/${'a'.repeat(2100)}`,
        'too-long',
      ],
    ];

    for (const [label, input, problem] of cases) {
      it(`${label} (${problem})`, () => {
        const result = normalizeGatewayUrl(input);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.problem).toBe(problem);
      });
    }
  });

  describe('insecure flag', () => {
    it('is false for https', () => {
      const result = normalizeGatewayUrl(NOTIFY);
      expect(result.ok && result.insecure).toBe(false);
    });

    it('is true for http, which stays usable', () => {
      // Synapse accepts http: pushers, and a LAN gateway is this feature's audience —
      // so this warns rather than blocks. Asserting `ok` here is the point: a
      // regression to rejecting http would break self-hosters.
      const result = normalizeGatewayUrl('http://192.168.1.10:5000');
      expect(result.ok).toBe(true);
      expect(result.ok && result.insecure).toBe(true);
      expect(result.ok && result.url).toBe(
        `http://192.168.1.10:5000${GATEWAY_NOTIFY_PATH}`,
      );
    });
  });

  it('is idempotent — normalising its own output changes nothing', () => {
    // The stored value is re-validated on load, so a second pass must be a no-op.
    for (const input of [NOTIFY, 'https://push.example.org', `${NOTIFY}/`]) {
      const once = normalizeGatewayUrl(input);
      expect(once.ok).toBe(true);
      const twice = normalizeGatewayUrl(once.ok ? once.url : '');
      expect(twice.ok && twice.url).toBe(once.ok && once.url);
    }
  });
});
