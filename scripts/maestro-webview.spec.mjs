import { describe, expect, it } from 'vitest';
import { openMaestroWebview } from '../e2e/android/maestro-webview.mts';

const descriptor = (overrides = {}) => ({
  id: '06A8',
  type: 'page',
  title: 'Trinity',
  url: 'https://localhost/login',
  description: JSON.stringify({
    attached: true,
    empty: false,
    height: 2209,
    visible: true,
    width: 1080,
  }),
  webSocketDebuggerUrl: 'ws://127.0.0.1:44663/devtools/page/06A8',
  ...overrides,
});

const browserVersion = () => ({
  json: async () => ({
    webSocketDebuggerUrl: 'ws://127.0.0.1:44663/devtools/browser/fixture',
  }),
});

function fixture({ targets = [descriptor()], connect } = {}) {
  const calls = [];
  const diagnostics = {
    closed: 0,
    close() {
      diagnostics.closed += 1;
    },
    async send(...args) {
      calls.push(['send', ...args]);
      return {};
    },
  };
  const device = {
    async adb(...args) {
      calls.push(['adb', ...args]);
      if (args[0] === 'shell') return '1234';
      return '4711';
    },
    async removeForward(local) {
      calls.push(['removeForward', local]);
    },
  };
  return {
    calls,
    device,
    diagnostics,
    fetch: async (input) =>
      input.endsWith('/json/version')
        ? browserVersion()
        : { json: async () => targets },
    connect: connect ?? (async () => diagnostics),
  };
}

describe('Maestro WebView attachment', () => {
  it('leases TLS from the browser endpoint before opening finite page diagnostics', async () => {
    const f = fixture();
    const browser = {
      closed: 0,
      close() {
        this.closed += 1;
      },
      async send(...args) {
        f.calls.push(['browser-send', ...args]);
        return {};
      },
    };
    const page = {
      closed: 0,
      close() {
        this.closed += 1;
      },
      async send(...args) {
        f.calls.push(['page-send', ...args]);
        return { result: { value: 1 } };
      },
    };
    const browserEndpoint = 'ws://127.0.0.1:44663/devtools/browser/actual';
    const pageEndpoint = descriptor().webSocketDebuggerUrl;
    const connections = [];
    const webview = await openMaestroWebview(f.device, {
      fetch: async (input) =>
        input.endsWith('/json/version')
          ? { json: async () => ({ webSocketDebuggerUrl: browserEndpoint }) }
          : { json: async () => [descriptor()] },
      connect: async (endpoint) => {
        connections.push(endpoint);
        return endpoint === browserEndpoint ? browser : page;
      },
    });

    expect(connections).toEqual([browserEndpoint]);
    expect(f.calls).toContainEqual([
      'browser-send',
      'Security.setIgnoreCertificateErrors',
      { ignore: true },
    ]);
    expect(f.calls).not.toContainEqual([
      'page-send',
      'Security.setIgnoreCertificateErrors',
      { ignore: true },
    ]);
    await webview.diagnostics.send('Runtime.evaluate', {});
    expect(connections).toEqual([browserEndpoint, pageEndpoint]);
    expect(page.closed).toBe(1);
    await webview.close();
    expect(browser.closed).toBe(1);
  });

  it('keeps browser TLS when the startup page disappears before any page command', async () => {
    const f = fixture();
    const browserEndpoint =
      'ws://127.0.0.1:44663/devtools/browser/startup-disappears';
    const browser = {
      closed: 0,
      close() {
        this.closed += 1;
      },
      async send(...args) {
        f.calls.push(['browser-send', ...args]);
        return {};
      },
    };
    const webview = await openMaestroWebview(f.device, {
      fetch: async (input) =>
        input.endsWith('/json/version')
          ? { json: async () => ({ webSocketDebuggerUrl: browserEndpoint }) }
          : Promise.reject(new Error('startup page disappeared')),
      connect: async (endpoint) => {
        expect(endpoint).toBe(browserEndpoint);
        return browser;
      },
    });
    expect(f.calls).toContainEqual([
      'browser-send',
      'Security.setIgnoreCertificateErrors',
      { ignore: true },
    ]);
    await webview.close();
    expect(browser.closed).toBe(1);
  });

  it('connects a replacement page once when the observed page disappears before dispatch', async () => {
    const f = fixture();
    const oldTarget = descriptor({
      webSocketDebuggerUrl: 'ws://127.0.0.1:44663/devtools/page/old',
    });
    const replacement = descriptor({
      id: '07B9',
      webSocketDebuggerUrl: 'ws://127.0.0.1:44663/devtools/page/new',
    });
    const browser = f.diagnostics;
    const page = {
      closed: 0,
      close() {
        this.closed += 1;
      },
      async send(...args) {
        f.calls.push(['replacement-send', ...args]);
        return { ok: true };
      },
    };
    let pageReads = 0;
    const connections = [];
    const webview = await openMaestroWebview(f.device, {
      fetch: async (input) => {
        if (input.endsWith('/json/version')) return browserVersion();
        return {
          json: async () => (pageReads++ === 0 ? [oldTarget] : [replacement]),
        };
      },
      connect: async (endpoint) => {
        connections.push(endpoint);
        if (endpoint === oldTarget.webSocketDebuggerUrl)
          throw new Error('old target closed');
        return endpoint === replacement.webSocketDebuggerUrl ? page : browser;
      },
    });
    await expect(webview.diagnostics.send('Runtime.evaluate')).resolves.toEqual(
      {
        ok: true,
      },
    );
    expect(connections).toEqual([
      'ws://127.0.0.1:44663/devtools/browser/fixture',
      oldTarget.webSocketDebuggerUrl,
      replacement.webSocketDebuggerUrl,
    ]);
    expect(page.closed).toBe(1);
    await webview.close();
  });

  it('propagates unchanged page connect failures without retrying', async () => {
    const f = fixture();
    const failure = new Error('page target unchanged');
    const connections = [];
    const webview = await openMaestroWebview(f.device, {
      fetch: async (input) =>
        input.endsWith('/json/version')
          ? browserVersion()
          : { json: async () => [descriptor()] },
      connect: async (endpoint) => {
        connections.push(endpoint);
        if (endpoint === descriptor().webSocketDebuggerUrl) throw failure;
        return f.diagnostics;
      },
    });
    await expect(webview.diagnostics.send('Runtime.evaluate')).rejects.toBe(
      failure,
    );
    expect(connections).toEqual([
      'ws://127.0.0.1:44663/devtools/browser/fixture',
      descriptor().webSocketDebuggerUrl,
    ]);
    await webview.close();
  });

  it('propagates ambiguous replacement discovery instead of selecting a later page', async () => {
    const f = fixture();
    const oldTarget = descriptor({
      webSocketDebuggerUrl: 'ws://127.0.0.1:44663/devtools/page/old',
    });
    const replacement = descriptor({
      id: '07B9',
      webSocketDebuggerUrl: 'ws://127.0.0.1:44663/devtools/page/new',
    });
    let pageReads = 0;
    const webview = await openMaestroWebview(f.device, {
      fetch: async (input) => {
        if (input.endsWith('/json/version')) return browserVersion();
        const targets =
          pageReads++ === 0
            ? [oldTarget]
            : pageReads === 2
              ? [oldTarget, replacement]
              : [replacement];
        return { json: async () => targets };
      },
      connect: async (endpoint) => {
        if (endpoint === oldTarget.webSocketDebuggerUrl)
          throw new Error('old target closed');
        return f.diagnostics;
      },
    });
    await expect(webview.diagnostics.send('Runtime.evaluate')).rejects.toThrow(
      'found 2',
    );
    await webview.close();
  });

  it('does not replay a command after page dispatch fails', async () => {
    const f = fixture();
    const failure = new Error('command failed after dispatch');
    const page = {
      close() {},
      async send() {
        throw failure;
      },
    };
    let pageConnections = 0;
    const webview = await openMaestroWebview(f.device, {
      fetch: async (input) =>
        input.endsWith('/json/version')
          ? browserVersion()
          : { json: async () => [descriptor()] },
      connect: async (endpoint) =>
        endpoint === descriptor().webSocketDebuggerUrl
          ? (++pageConnections, page)
          : f.diagnostics,
    });
    await expect(webview.diagnostics.send('Runtime.evaluate')).rejects.toBe(
      failure,
    );
    expect(pageConnections).toBe(1);
    await webview.close();
  });

  it('rejects a missing browser endpoint without opening a connection', async () => {
    const f = fixture();
    await expect(
      openMaestroWebview(f.device, {
        readinessTimeoutMs: 10,
        fetch: async () => ({ json: async () => ({}) }),
        connect: async () => {
          throw new Error('must not connect');
        },
      }),
    ).rejects.toThrow();
  });

  it('keeps an attached hidden Trinity page eligible for diagnostics', async () => {
    const f = fixture({
      targets: [
        descriptor({
          description: JSON.stringify({
            attached: true,
            empty: false,
            visible: false,
          }),
        }),
      ],
    });
    const webview = await openMaestroWebview(f.device, {
      fetch: f.fetch,
      connect: f.connect,
    });
    await expect(webview.diagnostics.send('Runtime.evaluate')).resolves.toEqual(
      {},
    );
    await webview.close();
  });

  it('closes a late page connection when an in-flight diagnostic is cancelled', async () => {
    const controller = new AbortController();
    const connected = Promise.withResolvers();
    const f = fixture();
    const page = {
      closed: 0,
      close() {
        this.closed += 1;
      },
      async send() {
        return {};
      },
    };
    const webview = await openMaestroWebview(f.device, {
      signal: controller.signal,
      fetch: f.fetch,
      connect: async (endpoint) =>
        endpoint.includes('/browser/') ? f.diagnostics : connected.promise,
    });
    const operation = webview.diagnostics.send('Runtime.evaluate');
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancel finite page diagnostic'));
    await expect(operation).rejects.toThrow('cancel finite page diagnostic');
    connected.resolve(page);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.closed).toBe(1);
    await webview.close();
  });

  it('waits through a transient missing process before attaching the ready target', async () => {
    const f = fixture();
    let pidReads = 0;
    f.device.adb = async (...args) => {
      f.calls.push(['adb', ...args]);
      if (args[0] === 'shell' && pidReads++ === 0)
        throw Object.assign(new Error('pidof'), {
          code: 1,
          stdout: '',
          stderr: '',
        });
      if (args[0] === 'shell') return '4321';
      return '4711';
    };
    const webview = await openMaestroWebview(f.device, {
      pollIntervalMs: 0,
      fetch: f.fetch,
      connect: f.connect,
    });
    expect(webview.pid).toBe('4321');
    expect(
      f.calls.filter((call) => call[0] === 'adb' && call[2] === 'pidof'),
    ).toHaveLength(2);
    await webview.close();
  });

  it('propagates a non-readiness ADB failure from the process probe', async () => {
    const f = fixture();
    const failure = Object.assign(new Error('offline'), {
      code: 1,
      stdout: '',
      stderr: 'error: device offline',
    });
    f.device.adb = async (...args) => {
      f.calls.push(['adb', ...args]);
      if (args[0] === 'shell') throw failure;
      return '4711';
    };
    await expect(
      openMaestroWebview(f.device, {
        readinessTimeoutMs: 1_000,
        fetch: f.fetch,
        connect: f.connect,
      }),
    ).rejects.toBe(failure);
    expect(f.calls).not.toContainEqual([
      'adb',
      'forward',
      'tcp:0',
      expect.any(String),
    ]);
  });

  it('cancels a pending process probe without waiting for the probe to resolve', async () => {
    const controller = new AbortController();
    const probing = Promise.withResolvers();
    const f = fixture();
    f.device.adb = async (...args) => {
      f.calls.push(['adb', ...args]);
      if (args[0] === 'shell') return probing.promise;
      return '4711';
    };
    const opening = openMaestroWebview(f.device, {
      signal: controller.signal,
      fetch: f.fetch,
      connect: f.connect,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancel process readiness'));
    await expect(opening).rejects.toThrow('cancel process readiness');
    probing.resolve('4321');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('keeps the attached connection alive after readiness expires until close', async () => {
    const f = fixture();
    let connectionSignal;
    const webview = await openMaestroWebview(f.device, {
      readinessTimeoutMs: 20,
      fetch: f.fetch,
      connect: async (_endpoint, options) => {
        connectionSignal = options.signal;
        return f.diagnostics;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(connectionSignal.aborted).toBe(false);
    await webview.close();
    expect(connectionSignal.aborted).toBe(true);
  });

  it('binds diagnostics to the explicitly selected secondary app process', async () => {
    const f = fixture();
    const webview = await openMaestroWebview(f.device, {
      applicationId: 'eu.qwky.trinity.secondary',
      fetch: f.fetch,
      connect: f.connect,
    });
    expect(f.calls).toContainEqual([
      'adb',
      'shell',
      'pidof',
      'eu.qwky.trinity.secondary',
    ]);
    expect(f.calls).not.toContainEqual([
      'adb',
      'shell',
      'pidof',
      'eu.qwky.trinity',
    ]);
    await webview.close();
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

  it('selects an attached page descriptor for each diagnostic command', async () => {
    const f = fixture();
    const webview = await openMaestroWebview(f.device, {
      fetch: f.fetch,
      connect: f.connect,
    });

    expect(f.calls).toContainEqual([
      'send',
      'Security.setIgnoreCertificateErrors',
      { ignore: true },
    ]);
    await webview.diagnostics.send('Runtime.evaluate');
    await webview.close();
    await webview.close();
    expect(f.diagnostics.closed).toBe(2);
    expect(f.calls.filter((call) => call[0] === 'removeForward')).toEqual([
      ['removeForward', 'tcp:4711'],
    ]);
  });

  it('polls through zero visible descriptors and rejects ambiguity', async () => {
    const empty = fixture({ targets: [] });
    let polls = 0;
    const webview = await openMaestroWebview(empty.device, {
      pollIntervalMs: 0,
      fetch: async (input) => ({
        json: async () =>
          input.endsWith('/json/version')
            ? browserVersion().json()
            : polls++ === 0
              ? []
              : [descriptor()],
      }),
      connect: empty.connect,
    });
    await expect(webview.diagnostics.send('Runtime.evaluate')).resolves.toEqual(
      {},
    );
    expect(polls).toBe(2);
    await webview.close();

    const ambiguous = fixture({
      targets: [descriptor(), descriptor({ id: '07B9' })],
    });
    const ambiguousWebview = await openMaestroWebview(ambiguous.device, {
      fetch: ambiguous.fetch,
      connect: ambiguous.connect,
    });
    await expect(
      ambiguousWebview.diagnostics.send('Runtime.evaluate'),
    ).rejects.toThrow('found 2');
    await ambiguousWebview.close();
    expect(ambiguous.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

  it('waits for the non-empty replacement before opening page diagnostics', async () => {
    const f = fixture();
    const startup = descriptor({
      url: 'https://localhost/',
      description: JSON.stringify({ visible: true, empty: true }),
      webSocketDebuggerUrl: 'ws://127.0.0.1:4711/devtools/page/startup',
    });
    const ready = descriptor();
    const connections = [];
    let polls = 0;
    const webview = await openMaestroWebview(f.device, {
      pollIntervalMs: 0,
      fetch: async (input) => ({
        json: async () =>
          input.endsWith('/json/version')
            ? browserVersion().json()
            : [polls++ === 0 ? startup : ready],
      }),
      connect: async (endpoint) => {
        connections.push(endpoint);
        return f.diagnostics;
      },
    });
    try {
      expect(connections).toEqual([
        'ws://127.0.0.1:44663/devtools/browser/fixture',
      ]);
      await webview.diagnostics.send('Runtime.evaluate');
      expect(connections).toEqual([
        'ws://127.0.0.1:44663/devtools/browser/fixture',
        ready.webSocketDebuggerUrl,
      ]);
      expect(polls).toBe(2);
      expect(f.calls).toContainEqual([
        'send',
        'Security.setIgnoreCertificateErrors',
        { ignore: true },
      ]);
    } finally {
      await webview.close();
    }
  });

  it.each(['', 'localhost'])(
    'waits for the app document after a non-empty startup target titled %j',
    async (title) => {
      const f = fixture();
      const startup = descriptor({
        title,
        url: 'https://localhost/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:4711/devtools/page/startup',
      });
      const ready = descriptor({ url: 'https://localhost/rooms' });
      const connections = [];
      let polls = 0;
      const webview = await openMaestroWebview(f.device, {
        pollIntervalMs: 0,
        fetch: async (input) => ({
          json: async () =>
            input.endsWith('/json/version')
              ? browserVersion().json()
              : [polls++ === 0 ? startup : ready],
        }),
        connect: async (endpoint) => {
          connections.push(endpoint);
          return f.diagnostics;
        },
      });
      try {
        expect(connections).toEqual([
          'ws://127.0.0.1:44663/devtools/browser/fixture',
        ]);
        await webview.diagnostics.send('Runtime.evaluate');
        expect(connections).toEqual([
          'ws://127.0.0.1:44663/devtools/browser/fixture',
          ready.webSocketDebuggerUrl,
        ]);
        expect(polls).toBe(2);
        expect(f.calls).toContainEqual([
          'send',
          'Security.setIgnoreCertificateErrors',
          { ignore: true },
        ]);
      } finally {
        await webview.close();
      }
    },
  );

  it('cancels a pending connection and removes the owned forward', async () => {
    const controller = new AbortController();
    const connected = Promise.withResolvers();
    const f = fixture({ connect: () => connected.promise });
    const opening = openMaestroWebview(f.device, {
      signal: controller.signal,
      fetch: f.fetch,
      connect: f.connect,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancel attachment'));
    await expect(opening).rejects.toThrow('cancel attachment');
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
    connected.resolve(f.diagnostics);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.diagnostics.closed).toBe(1);
  });

  it('does not allocate an ADB forward for an already cancelled fixture', async () => {
    const controller = new AbortController();
    controller.abort(new Error('fixture already cancelled'));
    const f = fixture();
    await expect(
      openMaestroWebview(f.device, {
        signal: controller.signal,
        fetch: f.fetch,
        connect: f.connect,
      }),
    ).rejects.toThrow('fixture already cancelled');
    expect(f.calls).toEqual([]);
  });

  it('awaits late forward removal and reports its failure after cancellation', async () => {
    const controller = new AbortController();
    const allocation = Promise.withResolvers();
    const allocating = Promise.withResolvers();
    const removal = Promise.withResolvers();
    const removing = Promise.withResolvers();
    const f = fixture();
    f.device.adb = async (...args) => {
      if (args[0] === 'shell') return '1234';
      allocating.resolve();
      return allocation.promise;
    };
    f.device.removeForward = async (local) => {
      f.calls.push(['removeForward', local]);
      removing.resolve();
      return removal.promise;
    };
    let settled = false;
    const opening = openMaestroWebview(f.device, {
      signal: controller.signal,
      fetch: f.fetch,
      connect: f.connect,
    }).catch((error) => {
      settled = true;
      return error;
    });
    await allocating.promise;
    controller.abort(new Error('cancel while allocating'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    allocation.resolve('4711');
    await removing.promise;
    expect(settled).toBe(false);
    removal.reject(new Error('late forward removal failed'));
    const failure = await opening;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0].message).toBe('cancel while allocating');
    expect(failure.errors[1].errors[0].message).toBe(
      'late forward removal failed',
    );
    expect(f.calls.filter((call) => call[0] === 'removeForward')).toEqual([
      ['removeForward', 'tcp:4711'],
    ]);
  });

  it('cancels empty-target readiness without waiting for the polling interval', async () => {
    const controller = new AbortController();
    const polled = Promise.withResolvers();
    const f = fixture();
    const opening = openMaestroWebview(f.device, {
      signal: controller.signal,
      pollIntervalMs: 60_000,
      fetch: async (input) => ({
        json: async () => {
          polled.resolve();
          return input.endsWith('/json/version') ? browserVersion().json() : [];
        },
      }),
      connect: f.connect,
    });
    await polled.promise;
    controller.abort(new Error('cancel readiness'));
    await expect(opening).rejects.toThrow('cancel readiness');
    expect(f.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

  it('polls while the forwarded inspector is still starting', async () => {
    const f = fixture();
    let attempts = 0;
    const webview = await openMaestroWebview(f.device, {
      pollIntervalMs: 0,
      fetch: async (input) => {
        if (attempts++ === 0) throw new Error('ECONNREFUSED');
        return {
          json: async () =>
            input.endsWith('/json/version')
              ? browserVersion().json()
              : [descriptor()],
        };
      },
      connect: f.connect,
    });
    expect(attempts).toBe(2);
    await webview.close();
  });

  it('preserves setup failure while reporting cleanup failure', async () => {
    const f = fixture({
      connect: async () => {
        throw new Error('CDP setup failed');
      },
    });
    f.device.removeForward = async () => {
      throw new Error('forward cleanup failed');
    };
    let failure;
    try {
      await openMaestroWebview(f.device, {
        fetch: f.fetch,
        connect: f.connect,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0].message).toBe('CDP setup failed');
    expect(failure.errors[1].errors[0].message).toBe('forward cleanup failed');
  });
});
