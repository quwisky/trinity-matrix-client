import { describe, expect, it } from 'vitest';
import { openMaestroWebview } from '../e2e/android/maestro-webview.mts';

const descriptor = (overrides = {}) => ({
  id: '06A8',
  type: 'page',
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
    fetch: async () => ({ json: async () => targets }),
    connect: connect ?? (async () => diagnostics),
  };
}

describe('Maestro WebView attachment', () => {
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

  it('selects a visible page descriptor and returns a raw CDP connection', async () => {
    const f = fixture();
    const webview = await openMaestroWebview(f.device, {
      fetch: f.fetch,
      connect: f.connect,
    });

    expect(webview.diagnostics).toBe(f.diagnostics);
    expect(f.calls).toContainEqual([
      'send',
      'Security.setIgnoreCertificateErrors',
      { ignore: true },
    ]);
    await webview.close();
    await webview.close();
    expect(f.diagnostics.closed).toBe(1);
    expect(f.calls.filter((call) => call[0] === 'removeForward')).toEqual([
      ['removeForward', 'tcp:4711'],
    ]);
  });

  it('polls through zero visible descriptors and rejects ambiguity', async () => {
    const empty = fixture({ targets: [] });
    let polls = 0;
    const webview = await openMaestroWebview(empty.device, {
      pollIntervalMs: 0,
      fetch: async () => ({
        json: async () => (polls++ === 0 ? [] : [descriptor()]),
      }),
      connect: empty.connect,
    });
    expect(polls).toBe(2);
    await webview.close();

    const ambiguous = fixture({
      targets: [descriptor(), descriptor({ id: '07B9' })],
    });
    await expect(
      openMaestroWebview(ambiguous.device, {
        fetch: ambiguous.fetch,
        connect: ambiguous.connect,
      }),
    ).rejects.toThrow('found 2');
    expect(ambiguous.calls).toContainEqual(['removeForward', 'tcp:4711']);
  });

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
      fetch: async () => ({
        json: async () => {
          polled.resolve();
          return [];
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
      fetch: async () => {
        if (attempts++ === 0) throw new Error('ECONNREFUSED');
        return { json: async () => [descriptor()] };
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
