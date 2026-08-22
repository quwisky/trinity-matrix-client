import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HapticsService } from './haptics.service';

// Same idiom as theme.service.spec.ts / mobile-badge.service.spec.ts: replace the plugin
// modules wholesale, then drive the spies per case. `ImpactStyle` is a real runtime enum the
// service reads, not just a type, so the mock has to carry it — exactly like the `Style` enum
// in theme.service.spec.ts.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));
vi.mock('@capacitor/haptics', () => ({
  Haptics: { impact: vi.fn() },
  ImpactStyle: { Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' },
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);

/**
 * A writable view of the mocked plugin, so a test can swap out what `impact` IS.
 *
 * That swap is the whole point of it. Vitest attaches its own `.then` to whatever a spy
 * returns, in order to record `mock.settledResults` — so a `vi.fn()` can never produce an
 * unhandled rejection, however it was configured. A "we swallow the rejection" test written
 * with `mockRejectedValue` passes whether or not the service catches anything. The rejecting
 * case below therefore installs a PLAIN function here instead of configuring the spy.
 *
 * `style` is widened to `string` so the assertions can name the waveform as the literal the
 * service actually sends, rather than reading it back out of the same mocked enum the service
 * read it from.
 */
type ImpactFn = (options: { style: string }) => Promise<void>;
const plugin = Haptics as unknown as { impact: ImpactFn };
const impactSpy = vi.fn<ImpactFn>();

/** Let the fire-and-forget call settle, and give Node a turn to report an escaped rejection. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function makeService(): HapticsService {
  TestBed.configureTestingModule({ providers: [HapticsService] });
  return TestBed.inject(HapticsService);
}

describe('HapticsService', () => {
  let escaped: unknown[];
  const record = (reason: unknown) => escaped.push(reason);

  beforeEach(() => {
    escaped = [];
    process.on('unhandledRejection', record);
    isNative.mockReset().mockReturnValue(true); // a phone, unless a test says otherwise
    plugin.impact = impactSpy;
    impactSpy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.off('unhandledRejection', record);
    TestBed.resetTestingModule();
  });

  it('taps the plugin once on a native platform', async () => {
    makeService().gestureCommitted();
    await flush();

    expect(impactSpy).toHaveBeenCalledTimes(1);
    // Pinned deliberately: the style is a taste decision the service makes ONCE so that no
    // call site has to. Changing it should be a visible one-line edit here, not a drift.
    expect(impactSpy).toHaveBeenCalledWith({ style: 'MEDIUM' });
  });

  it('does nothing at all when isNativePlatform() is false', async () => {
    // Web and the Electron shell both land here — `isNativePlatform()` is false in Electron,
    // and that is the behaviour we want, since a desktop has nothing to vibrate.
    isNative.mockReturnValue(false);

    makeService().gestureCommitted();
    await flush();

    expect(impactSpy).not.toHaveBeenCalled();
  });

  it('taps on every commit, not just the first', async () => {
    // Guards against a readiness probe being memoized in here later, the way
    // MobileBadgeService memoizes its permission request: a drawer that buzzed once and then
    // went quiet for the rest of the session would read as a flaky device, not as a bug here.
    const service = makeService();
    service.gestureCommitted();
    service.gestureCommitted();
    await flush();

    expect(impactSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows a rejecting plugin: no throw, no escaped rejection', async () => {
    // A PLAIN function, not `impactSpy.mockRejectedValue(...)` — see `plugin` above. This is
    // the real device case: no haptic engine, or a simulator.
    let calls = 0;
    plugin.impact = () => {
      calls += 1;
      return Promise.reject(new Error('no haptic engine'));
    };

    const service = makeService();

    expect(() => service.gestureCommitted()).not.toThrow();
    await flush();

    expect(calls).toBe(1);
    expect(escaped).toEqual([]);
  });

  it('swallows a bridge that throws synchronously instead of rejecting', async () => {
    // An unregistered plugin can fail at the bridge rather than by rejecting. The caller is a
    // pointer handler mid-gesture, so a throw here would abort the gesture, not just the tick.
    plugin.impact = () => {
      throw new Error('plugin not implemented on this platform');
    };

    const service = makeService();

    expect(() => service.gestureCommitted()).not.toThrow();
    await flush();

    expect(escaped).toEqual([]);
  });
});
