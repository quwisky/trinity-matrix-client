import { describe, expect, it } from 'vitest';
import { openMaestroViewport } from '../e2e/android/maestro-viewport.mts';

const target = (overrides = {}) => ({
  type: 'page',
  title: 'Trinity',
  url: 'https://localhost/login',
  description: JSON.stringify({
    attached: true,
    empty: false,
    screenX: 0,
    screenY: 128,
    width: 1080,
    height: 2209,
  }),
  webSocketDebuggerUrl: 'ws://127.0.0.1:4711/devtools/page/trinity',
  ...overrides,
});

function fixture({
  targets = [target()],
  metrics = { width: 1080, height: 2209, dpr: 1 },
  physical = 390,
  userAgent = 'Mozilla/5.0 (Android) Trinity Fixture',
} = {}) {
  const calls = [];
  const page = {
    closed: 0,
    close() {
      page.closed++;
    },
    async send(method, params) {
      calls.push(['send', method, params]);
      if (
        method === 'Runtime.evaluate' &&
        params?.expression === 'navigator.userAgent'
      )
        return { result: { result: { value: userAgent } } };
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
  it('keeps document scripts on the retained session and removes them exactly once', async () => {
    const f = fixture();
    const originalSend = f.page.send.bind(f.page);
    let registrations = 0;
    f.page.send = async (method, params) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        expect(f.calls.at(-1)).toEqual(['send', 'Page.enable', undefined]);
        f.calls.push(['send', method, params]);
        return { identifier: `script-${++registrations}` };
      }
      return originalSend(method, params);
    };
    let connections = 0;
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: f.fetch,
      connect: async () => {
        connections++;
        return f.page;
      },
    });
    const removeFirst =
      await viewport.installDocumentScript('window.fixture = 1');
    await viewport.installDocumentScript('window.otherFixture = 2');
    await viewport.apply();
    expect(connections).toBe(1);
    expect(f.page.closed).toBe(0);
    await removeFirst();
    await removeFirst();
    await viewport.close();
    await removeFirst();
    expect(
      f.calls.filter(
        ([, method]) => method === 'Page.removeScriptToEvaluateOnNewDocument',
      ),
    ).toEqual([
      [
        'send',
        'Page.removeScriptToEvaluateOnNewDocument',
        { identifier: 'script-1' },
      ],
      [
        'send',
        'Page.removeScriptToEvaluateOnNewDocument',
        { identifier: 'script-2' },
      ],
    ]);
    expect(f.page.closed).toBe(1);
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

  it('releases the page and forward even when document script cleanup fails', async () => {
    const f = fixture();
    const originalSend = f.page.send.bind(f.page);
    f.page.send = async (method, params) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument')
        return { identifier: 'fixture' };
      if (method === 'Page.removeScriptToEvaluateOnNewDocument')
        throw new Error('script removal failed');
      return originalSend(method, params);
    };
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: f.fetch,
      connect: f.connect,
    });
    await viewport.installDocumentScript('window.fixture = true');
    await expect(viewport.close()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'script removal failed' })],
    });
    expect(f.page.closed).toBe(1);
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

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

  it('preserves defaults while supporting nonmobile, nontouch profiles', async () => {
    const defaults = fixture();
    const defaultViewport = await openMaestroViewport(defaults.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: defaults.fetch,
      connect: defaults.connect,
    });
    await defaultViewport.apply();
    expect(defaults.calls).toContainEqual([
      'send',
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        mobile: true,
        deviceScaleFactor: 1,
        width: 390,
        height: 844,
      }),
    ]);
    expect(defaults.calls).toContainEqual([
      'send',
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
    ]);
    await defaultViewport.close();

    const wide = fixture();
    const wideViewport = await openMaestroViewport(wide.device, {
      pid: '1234',
      width: 1280,
      height: 720,
      deviceScaleFactor: 2.75,
      isMobile: false,
      hasTouch: false,
      fetch: wide.fetch,
      connect: wide.connect,
    });
    await wideViewport.apply();
    expect(wide.calls).toContainEqual([
      'send',
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        mobile: false,
        deviceScaleFactor: 2.75,
        width: 1280,
        height: 720,
      }),
    ]);
    expect(wide.calls).toContainEqual([
      'send',
      'Emulation.setTouchEmulationEnabled',
      { enabled: false, maxTouchPoints: 1 },
    ]);
    await wideViewport.close();
  });

  it('resizes the same retained owner and reapplies its current size without arguments', async () => {
    const f = fixture();
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 393,
      height: 727,
      deviceScaleFactor: 2.75,
      fetch: f.fetch,
      connect: f.connect,
    });
    await viewport.apply({ width: 390, height: 844 });
    expect(f.calls).toContainEqual([
      'send',
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        width: 390,
        height: 844,
        deviceScaleFactor: 2.75,
      }),
    ]);
    await viewport.apply({ width: 390, height: 260 });
    expect(f.calls).toContainEqual([
      'send',
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ width: 390, height: 260 }),
    ]);
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
    expect(f.calls).toContainEqual([
      'send',
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({ width: 390, height: 260 }),
    ]);
    await viewport.close();
  });

  it('restores the original user agent and reports restoration failures', async () => {
    const f = fixture({ userAgent: 'Original UA' });
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      userAgent: 'Pixel 5 UA',
      fetch: f.fetch,
      connect: f.connect,
    });
    expect(f.calls).toContainEqual([
      'send',
      'Network.setUserAgentOverride',
      { userAgent: 'Pixel 5 UA' },
    ]);
    await viewport.close();
    expect(f.calls).toContainEqual([
      'send',
      'Network.setUserAgentOverride',
      { userAgent: 'Original UA' },
    ]);

    const failure = fixture({ userAgent: 'Original UA' });
    failure.page.send = async (method, params) => {
      failure.calls.push(['send', method, params]);
      if (method === 'Runtime.evaluate')
        return { result: { result: { value: 'Original UA' } } };
      if (
        method === 'Network.setUserAgentOverride' &&
        params.userAgent === 'Original UA'
      )
        throw new Error('UA restore failed');
      return {};
    };
    const failingViewport = await openMaestroViewport(failure.device, {
      pid: '1234',
      width: 390,
      height: 844,
      userAgent: 'Pixel 5 UA',
      fetch: failure.fetch,
      connect: failure.connect,
    });
    await expect(failingViewport.close()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'UA restore failed' })],
    });

    const partial = fixture({ userAgent: 'Original UA' });
    let currentUserAgent = 'Original UA';
    partial.page.send = async (method, params) => {
      partial.calls.push(['send', method, params]);
      if (method === 'Runtime.evaluate')
        return { result: { result: { value: currentUserAgent } } };
      if (method === 'Network.setUserAgentOverride') {
        currentUserAgent = params.userAgent;
        if (params.userAgent === 'Pixel 5 UA')
          throw new Error('UA dispatch failed');
      }
      return {};
    };
    await expect(
      openMaestroViewport(partial.device, {
        pid: '1234',
        width: 390,
        height: 844,
        userAgent: 'Pixel 5 UA',
        fetch: partial.fetch,
        connect: partial.connect,
      }),
    ).rejects.toThrow('UA dispatch failed');
    expect(currentUserAgent).toBe('Original UA');
    expect(partial.calls).toContainEqual([
      'send',
      'Network.setUserAgentOverride',
      { userAgent: 'Original UA' },
    ]);
    expect(partial.page.closed).toBe(1);
    expect(partial.calls).toContainEqual(['removeForward', 'tcp:4711']);
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

  it('maps wide and narrow CSS points using separate physical target and CSS widths', async () => {
    const wide = fixture({ physical: 411.43 });
    const wideViewport = await openMaestroViewport(wide.device, {
      pid: '1234',
      width: 1280,
      height: 720,
      fetch: wide.fetch,
      connect: wide.connect,
    });
    await wideViewport.apply();
    await expect(wideViewport.nativePoint({ x: 640, y: 384 })).resolves.toEqual(
      {
        x: 540,
        y: 452,
      },
    );
    await wideViewport.close();

    const narrow = fixture({ physical: 411.43 });
    const narrowViewport = await openMaestroViewport(narrow.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: narrow.fetch,
      connect: narrow.connect,
    });
    await narrowViewport.apply();
    await expect(
      narrowViewport.nativePoint({ x: 195, y: 422 }),
    ).resolves.toEqual({
      x: 512,
      y: 1236,
    });
    await narrowViewport.apply({ width: 390, height: 260 });
    await expect(
      narrowViewport.nativePoint({ x: 195, y: 130 }),
    ).resolves.toEqual({
      x: 512,
      y: 469,
    });
    await narrowViewport.close();
  });

  it('rejects invalid, out-of-bounds, ambiguous, replaced, and width-drifted native points', async () => {
    const f = fixture();
    const viewport = await openMaestroViewport(f.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: f.fetch,
      connect: f.connect,
    });
    await viewport.apply();
    await expect(viewport.nativePoint({ x: -1, y: 10 })).rejects.toThrow(
      'outside',
    );
    await expect(
      viewport.nativePoint({ x: Number.NaN, y: 10 }),
    ).rejects.toThrow('outside');
    await viewport.close();

    let reads = 0;
    const drifting = fixture();
    const driftedTarget = target({
      description: JSON.stringify({
        attached: true,
        empty: false,
        screenX: 0,
        screenY: 128,
        width: 900,
        height: 2209,
      }),
    });
    const driftViewport = await openMaestroViewport(drifting.device, {
      pid: '1234',
      width: 390,
      height: 844,
      fetch: async () => ({
        json: async () => (reads++ < 2 ? [target()] : [driftedTarget]),
      }),
      connect: drifting.connect,
    });
    await driftViewport.apply();
    await expect(driftViewport.nativePoint({ x: 10, y: 10 })).rejects.toThrow(
      'width changed',
    );
    await driftViewport.close();
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
