import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Preferences } from '@capacitor/preferences';
import { FeatureFlagsService } from './feature-flags.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;

const KEY = 'trinity.flags.virtual-timeline';
const DEFER_MEDIA_KEY = 'trinity.flags.defer-media-while-scrolling';
const FLING_PLACEHOLDERS_KEY = 'trinity.flags.fling-placeholders';

/** Answer `Preferences.get` from a key → stored value table; unlisted keys hold nothing. */
function stored(values: Record<string, string>): void {
  get.mockImplementation(async ({ key }: { key: string }) => ({
    value: values[key] ?? null,
  }));
}

describe('FeatureFlagsService', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
  });

  function service(): FeatureFlagsService {
    TestBed.configureTestingModule({ providers: [FeatureFlagsService] });
    return TestBed.inject(FeatureFlagsService);
  }

  it('defaults the virtualized-timeline flag to on', () => {
    // The non-windowed list retains every loaded row unbounded; windowing is the
    // safe default. An explicit stored preference still overrides it (below).
    expect(service().virtualTimeline()).toBe(true);
  });

  it('keeps the default when nothing is stored', async () => {
    const svc = service();
    await expect(svc.init()).resolves.toEqual({ kind: 'ready' });
    expect(svc.virtualTimeline()).toBe(true);
  });

  it('restores a stored "true" flag on init', async () => {
    get.mockResolvedValue({ value: 'true' });
    const svc = service();
    await expect(svc.init()).resolves.toEqual({ kind: 'ready' });
    expect(svc.virtualTimeline()).toBe(true);
    expect(get).toHaveBeenCalledWith({ key: KEY });
  });

  it('treats any non-"true" stored value as off', async () => {
    get.mockResolvedValue({ value: 'false' });
    const svc = service();
    await svc.init();
    expect(svc.virtualTimeline()).toBe(false);
  });

  it('keeps the default (on) when storage throws', async () => {
    get.mockRejectedValue(new Error('unavailable'));
    const svc = service();
    await expect(svc.init()).resolves.toEqual({
      kind: 'defaulted',
      reason: 'storage-unavailable',
    });
    expect(svc.virtualTimeline()).toBe(true);
  });

  it('setVirtualTimeline updates the signal and persists the choice', () => {
    const svc = service();

    svc.setVirtualTimeline(true);
    expect(svc.virtualTimeline()).toBe(true);
    expect(set).toHaveBeenCalledWith({ key: KEY, value: 'true' });

    svc.setVirtualTimeline(false);
    expect(svc.virtualTimeline()).toBe(false);
    expect(set).toHaveBeenLastCalledWith({ key: KEY, value: 'false' });
  });

  describe('defer media while scrolling', () => {
    it('is off until the person opts in', async () => {
      const svc = service();
      expect(svc.deferMediaWhileScrolling()).toBe(false);
      await expect(svc.init()).resolves.toEqual({ kind: 'ready' });
      expect(svc.deferMediaWhileScrolling()).toBe(false);
    });

    it('restores a stored opt-in on init, independently of the other flags', async () => {
      stored({ [DEFER_MEDIA_KEY]: 'true', [KEY]: 'false' });
      const svc = service();

      await expect(svc.init()).resolves.toEqual({ kind: 'ready' });

      expect(svc.deferMediaWhileScrolling()).toBe(true);
      expect(svc.virtualTimeline()).toBe(false);
    });

    it('keeps it off and reports an invalid stored value', async () => {
      stored({ [DEFER_MEDIA_KEY]: 'yes', [KEY]: 'false' });
      const svc = service();

      await expect(svc.init()).resolves.toEqual({
        kind: 'defaulted',
        reason: 'invalid-stored-value',
      });

      expect(svc.deferMediaWhileScrolling()).toBe(false);
      // The valid flag beside it is still applied.
      expect(svc.virtualTimeline()).toBe(false);
    });

    it('persists a toggle and moves the signal at once', () => {
      const svc = service();

      svc.setDeferMediaWhileScrolling(true);
      expect(svc.deferMediaWhileScrolling()).toBe(true);
      expect(set).toHaveBeenCalledWith({ key: DEFER_MEDIA_KEY, value: 'true' });

      svc.setDeferMediaWhileScrolling(false);
      expect(svc.deferMediaWhileScrolling()).toBe(false);
      expect(set).toHaveBeenLastCalledWith({
        key: DEFER_MEDIA_KEY,
        value: 'false',
      });
    });
  });

  describe('fling placeholders', () => {
    it('is off until the person opts in', async () => {
      const svc = service();
      expect(svc.flingPlaceholders()).toBe(false);
      await expect(svc.init()).resolves.toEqual({ kind: 'ready' });
      expect(svc.flingPlaceholders()).toBe(false);
    });

    it('restores a stored opt-in on init, independently of the other flags', async () => {
      stored({ [FLING_PLACEHOLDERS_KEY]: 'true', [DEFER_MEDIA_KEY]: 'false' });
      const svc = service();

      await expect(svc.init()).resolves.toEqual({ kind: 'ready' });

      expect(svc.flingPlaceholders()).toBe(true);
      expect(svc.deferMediaWhileScrolling()).toBe(false);
    });

    it('keeps it off and reports an invalid stored value', async () => {
      stored({ [FLING_PLACEHOLDERS_KEY]: '1', [DEFER_MEDIA_KEY]: 'true' });
      const svc = service();

      await expect(svc.init()).resolves.toEqual({
        kind: 'defaulted',
        reason: 'invalid-stored-value',
      });

      expect(svc.flingPlaceholders()).toBe(false);
      expect(svc.deferMediaWhileScrolling()).toBe(true);
    });

    it('persists a toggle and moves the signal at once', () => {
      const svc = service();

      svc.setFlingPlaceholders(true);
      expect(svc.flingPlaceholders()).toBe(true);
      expect(set).toHaveBeenCalledWith({
        key: FLING_PLACEHOLDERS_KEY,
        value: 'true',
      });

      svc.setFlingPlaceholders(false);
      expect(svc.flingPlaceholders()).toBe(false);
      expect(set).toHaveBeenLastCalledWith({
        key: FLING_PLACEHOLDERS_KEY,
        value: 'false',
      });
    });
  });
});
