import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerSettingsService } from './composer-settings.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = vi.mocked(Preferences.get);
const set = vi.mocked(Preferences.set);

function build(): ComposerSettingsService {
  return TestBed.configureTestingModule({}).inject(ComposerSettingsService);
}

describe('ComposerSettingsService', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
  });

  it('shows the toolbar until told otherwise', async () => {
    const svc = build();
    expect(svc.showFormattingToolbar()).toBe(true);

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(true);
  });

  it('restores a stored preference', async () => {
    get.mockResolvedValue({ value: 'false' });
    const svc = build();

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(false);
  });

  it('persists a change under the composer key', () => {
    const svc = build();

    svc.setShowFormattingToolbar(false);

    expect(svc.showFormattingToolbar()).toBe(false);
    expect(set).toHaveBeenCalledWith({
      key: 'trinity.composer.show-toolbar',
      value: 'false',
    });
  });

  it('keeps the default when storage is unavailable', async () => {
    get.mockRejectedValue(new Error('no storage'));
    const svc = build();

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(true);
  });
});
