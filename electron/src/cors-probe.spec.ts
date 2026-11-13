import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, fromPartition } = vi.hoisted(() => {
  const fetchMock = vi.fn();
  return { fetchMock, fromPartition: vi.fn(() => ({ fetch: fetchMock })) };
});

vi.mock('electron', () => ({ session: { fromPartition } }));

import { probeMatrixOrigin } from './cors-probe';

const HS = 'https://hs.example';
const VERSIONS = `${HS}/_matrix/client/versions`;
const WELL_KNOWN = `${HS}/.well-known/matrix/client`;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const notFound = (): Response => new Response('not found', { status: 404 });

/** Answer each probed URL from `answers`; anything else is a 404. */
function serve(answers: Record<string, () => Response | Promise<Response>>) {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve((answers[url] ?? notFound)()),
  );
}

describe('probeMatrixOrigin', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('accepts an origin that answers the versions endpoint like a homeserver', async () => {
    serve({ [VERSIONS]: () => json({ versions: ['v1.1', 'v1.11'] }) });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('homeserver');
  });

  it('accepts a delegating server name for its well-known document only', async () => {
    serve({
      [WELL_KNOWN]: () =>
        json({ 'm.homeserver': { base_url: 'https://matrix.hs.example' } }),
    });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('well-known');
  });

  it('asks without credentials, without following redirects, in a cookie-less session', async () => {
    serve({ [VERSIONS]: () => json({ versions: ['v1.11'] }) });

    await probeMatrixOrigin(HS);

    expect(fromPartition).toHaveBeenCalledWith('trinity-cors-probe');
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('refuses an origin that answers 404', async () => {
    serve({});

    await expect(probeMatrixOrigin(HS)).resolves.toBe('refused');
  });

  it('accepts a homeserver without waiting for a well-known that hangs', async () => {
    serve({
      [VERSIONS]: () => json({ versions: ['v1.11'] }),
      [WELL_KNOWN]: () => new Promise<Response>(() => undefined),
    });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('homeserver');
  });

  it('accepts the historical version form', async () => {
    serve({ [VERSIONS]: () => json({ versions: ['r0.6.1'] }) });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('homeserver');
  });

  it.each([[[]], [['grafana', 9]], [['1.11']], [[' v1.11']]])(
    'refuses a versions array with no Matrix spec version: %j',
    async (versions) => {
      serve({ [VERSIONS]: () => json({ versions }) });

      await expect(probeMatrixOrigin(HS)).resolves.toBe('refused');
    },
  );

  it('refuses a body that is not JSON', async () => {
    serve({ [VERSIONS]: () => new Response('<html>intranet wiki</html>') });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('refused');
  });

  it('refuses JSON that is not a versions answer', async () => {
    serve({
      [VERSIONS]: () => json({ versions: 'v1.1' }),
      [WELL_KNOWN]: () => json({ 'm.homeserver': {} }),
    });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('refused');
  });

  // Electron fails a `redirect: 'manual'` fetch on a 3xx: it never returns the response.
  it('refuses a host that redirects, so it is not asked again on every response', async () => {
    serve({
      [VERSIONS]: () => Promise.reject(new Error('Redirect was cancelled')),
    });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('refused');
  });

  it('refuses a response that was redirected anyway', async () => {
    const redirected = json({ versions: ['v1.1'] });
    Object.defineProperty(redirected, 'redirected', { value: true });
    serve({ [VERSIONS]: () => redirected });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('refused');
  });

  it('refuses an oversized body without reading it all', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16_384).fill(0x20));
      },
    });
    serve({ [VERSIONS]: () => new Response(endless) });

    await expect(probeMatrixOrigin(HS)).resolves.toBe('refused');
    expect(pulled).toBeLessThan(10);
  });

  it('reports a timeout as unreachable, not as a refusal', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(probeMatrixOrigin(HS)).resolves.toBe('unreachable');
  });

  it('reports a network failure as unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('net::ERR_NAME_NOT_RESOLVED'));

    await expect(probeMatrixOrigin(HS)).resolves.toBe('unreachable');
  });

  it('refuses http without asking', async () => {
    await expect(probeMatrixOrigin('http://hs.example')).resolves.toBe(
      'refused',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
