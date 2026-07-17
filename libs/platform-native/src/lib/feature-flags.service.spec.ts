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
    await svc.init();
    expect(svc.virtualTimeline()).toBe(true);
  });

  it('restores a stored "true" flag on init', async () => {
    get.mockResolvedValue({ value: 'true' });
    const svc = service();
    await svc.init();
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
    await svc.init();
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
});
