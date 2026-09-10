import { describe, expect, it } from 'vitest';
import { openMaestroViewport } from '../e2e/android/maestro-viewport.mts';

const target = (overrides = {}) => ({
  type: 'page',
  title: 'Trinity',
  url: 'https://localhost/login',
  description: JSON.stringify({ attached: true, empty: false }),
  webSocketDebuggerUrl: 'ws://127.0.0.1:4711/devtools/page/trinity',
  ...overrides,
});

function fixture({
  targets = [target()],
  metrics = { width: 1080, height: 2209, dpr: 1 },
  physical = 390,
} = {}) {
  const calls = [];
  const page = {
    closed: 0,
    close() {
      page.closed++;
    },
    async send(method, params) {
      calls.push(['send', method, params]);
      if (method === 'Runtime.evaluate')
        return { result: { result: { value: metrics } } };
      if (method === 'Page.getLayoutMetrics')
        return physical ? { cssVisualViewport: { clientWidth: physical } } : {};
      if (method === 'Emulation.setDeviceMetricsOverride') {
        metrics.width = params.width;
        metrics.height = params.height;
        metrics.dpr = params.deviceScaleFactor;
      }
      return {};
    },
  };
  const device = {
    async adb(...args) {
      calls.push(['adb', ...args]);
      return '4711';
    },
    async removeForward(local) {
      calls.push(['removeForward', local]);
    },
  };
  return {
    calls,
    page,
    device,
    fetch: async () => ({ json: async () => targets }),
    connect: async () => page,
  };
}

describe('Maestro viewport ownership', () => {
  it('retains one page connection and avoids resetting an unchanged layout', async () => {
    const f = fixture();
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: f.fetch,
      connect: f.connect,
    });
    await viewport.apply();
    expect(f.calls.filter(([kind]) => kind === 'send')).toHaveLength(5);
    await viewport.apply();
    expect(f.calls.filter(([kind]) => kind === 'send')).toHaveLength(6);
    expect(f.calls).toContainEqual([
      'send',
      'Emulation.clearDeviceMetricsOverride',
      undefined,
    ]);
    await viewport.close();
    expect(f.page.closed).toBe(1);
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

  it('reapplies after screenshot-like metric reset while retaining the page', async () => {
    const f = fixture({ metrics: { width: 390, height: 844, dpr: 1 } });
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: f.fetch,
      connect: f.connect,
    });
    await viewport.apply();
    f.page.send = async (method, params) => {
      f.calls.push(['send', method, params]);
      if (method === 'Runtime.evaluate')
        return {
          result: { result: { value: { width: 1080, height: 2209, dpr: 1 } } },
        };
      if (method === 'Page.getLayoutMetrics')
        return { cssVisualViewport: { clientWidth: 390 } };
      return {};
    };
    await viewport.apply();
    expect(
      f.calls.filter(
        ([kind, method]) =>
          kind === 'send' && method === 'Emulation.setDeviceMetricsOverride',
      ),
    ).toHaveLength(2);
    await viewport.close();
  });

  it('fails on ambiguous or replaced Trinity targets', async () => {
    const ambiguous = fixture({
      targets: [target(), target({ id: 'second' })],
    });
    await expect(
      openMaestroViewport(ambiguous.device, {
        pid: '1234',
        width: 390,
        height: 844,
        fetch: ambiguous.fetch,
        connect: ambiguous.connect,
      }),
    ).rejects.toThrow('found 2');

    const f = fixture();
    let reads = 0;
    const replacement = target({
      webSocketDebuggerUrl: 'ws://127.0.0.1:4711/devtools/page/replacement',
    });
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: async () => ({
        json: async () => (reads++ === 0 ? [target()] : [replacement]),
      }),
      connect: f.connect,
    });
    await expect(viewport.apply()).rejects.toThrow('replaced');
    await viewport.close();

    const malformed = fixture({
      targets: [target({ description: '{broken' })],
    });
    await expect(
      openMaestroViewport(malformed.device, {
        pid: '1234',
        width: 390,
        height: 844,
        fetch: malformed.fetch,
        connect: malformed.connect,
      }),
    ).rejects.toThrow('found 0');
  });

  it('closes a connection that completes after attach cancellation', async () => {
    const controller = new AbortController();
    const f = fixture();
    let resolveConnection;
    const latePage = {
      closed: 0,
      close() {
        latePage.closed++;
      },
      async send() {
        return {};
      },
    };
    const opening = openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      signal: controller.signal,
      fetch: f.fetch,
      connect: async () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('connect cancelled'));
    await expect(opening).rejects.toThrow('connect cancelled');
    resolveConnection(latePage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(latePage.closed).toBe(1);
  });

  it('uses the physical layout width to preserve native touch scale', async () => {
    const f = fixture({ physical: 200 });
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: f.fetch,
      connect: f.connect,
    });
    await viewport.apply();
    expect(f.calls).toContainEqual([
      'send',
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ scale: 200 / 390 }),
    ]);
    await viewport.close();
  });

  it('reports clear and forward removal failures while attempting both cleanups', async () => {
    const f = fixture();
    f.page.send = async (method, params) => {
      f.calls.push(['send', method, params]);
      if (method === 'Emulation.clearDeviceMetricsOverride')
        throw new Error('clear failed');
      return {};
    };
    f.device.removeForward = async () => {
      throw new Error('remove failed');
    };
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: f.fetch,
      connect: f.connect,
    });
    await expect(viewport.close()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'clear failed' }),
        expect.objectContaining({ message: 'remove failed' }),
      ],
    });
    expect(f.page.closed).toBe(1);
  });

  it('cleans the retained owner when its caller signal aborts', async () => {
    const controller = new AbortController();
    const f = fixture();
    await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      signal: controller.signal,
      fetch: f.fetch,
      connect: f.connect,
    });
    controller.abort(new Error('owner cancelled'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.page.closed).toBe(1);
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

  it('cleans a late forward after cancellation', async () => {
    const controller = new AbortController();
    let resolveForward;
    const f = fixture();
    f.device.adb = async (...args) => {
      f.calls.push(['adb', ...args]);
      return new Promise((resolve) => {
        resolveForward = resolve;
      });
    };
    const opening = openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      signal: controller.signal,
      fetch: f.fetch,
      connect: f.connect,
    });
    controller.abort(new Error('cancelled'));
    await expect(opening).rejects.toThrow('cancelled');
    resolveForward('4711');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });
});
