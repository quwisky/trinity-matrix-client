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

const PIN = 'trinity.composer.show-toolbar';
const ON_SELECTION = 'trinity.composer.format-on-selection';

describe('ComposerSettingsService', () => {
  /** What storage holds, keyed — the two preferences have to be settable apart. */
  let stored: Record<string, string | null>;

  beforeEach(() => {
    stored = {};
    get
      .mockReset()
      .mockImplementation(({ key }) =>
        Promise.resolve({ value: stored[key] ?? null }),
      );
    set.mockReset().mockImplementation(({ key, value }) => {
      stored[key] = value;
      return Promise.resolve();
    });
  });

  it('shows the toolbar until told otherwise', async () => {
    const svc = build();
    expect(svc.showFormattingToolbar()).toBe(true);

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(true);
  });

  it('restores a stored preference', async () => {
    stored[PIN] = 'false';
    const svc = build();

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(false);
  });

  it('raises on a selection until told otherwise', async () => {
    const svc = build();

    await svc.init();

    expect(svc.formatOnSelection()).toBe(true);
  });

  it('does not start raising the bar on someone who had turned it off', async () => {
    // The whole reason this is two preferences rather than one redefined. They chose *never*;
    // defaulting the new one to true would answer that by showing the bar on every selection.
    stored[PIN] = 'false';
    const svc = build();

    await svc.init();

    expect(svc.formatOnSelection()).toBe(false);
    // Written back, so the inheritance happens once — after this the two are independent.
    expect(stored[ON_SELECTION]).toBe('false');
  });

  it('leaves someone who never expressed a view on the defaults', async () => {
    const svc = build();

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(true);
    expect(svc.formatOnSelection()).toBe(true);
    expect(stored[ON_SELECTION]).toBeUndefined(); // nothing to migrate, nothing written
  });

  it('inherits from a stored value that is neither true nor false', async () => {
    // A corrupt or hand-edited value is not `'true'`, so the bar reads as unpinned — and the
    // inheritance has to agree with that rather than testing the raw string for `'false'`.
    stored[PIN] = 'nope';
    const svc = build();

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(false);
    expect(svc.formatOnSelection()).toBe(false);
  });

  it('lets the two disagree once both are stored', async () => {
    // The state the split exists to make expressible: no pinned row, but a bar on selection.
    stored[PIN] = 'false';
    stored[ON_SELECTION] = 'true';
    const svc = build();

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(false);
    expect(svc.formatOnSelection()).toBe(true);
  });

  it('does not re-run the migration once the new key is stored', async () => {
    // Someone who was migrated to false and then turned it back on must stay on.
    stored[PIN] = 'false';
    stored[ON_SELECTION] = 'true';
    const svc = build();

    await svc.init();

    expect(svc.formatOnSelection()).toBe(true);
  });

  it('persists the selection preference under its own key', () => {
    const svc = build();

    svc.setFormatOnSelection(false);

    expect(svc.formatOnSelection()).toBe(false);
    expect(set).toHaveBeenCalledWith({ key: ON_SELECTION, value: 'false' });
  });

  it('persists a change under the composer key', () => {
    const svc = build();

    svc.setShowFormattingToolbar(false);

    expect(svc.showFormattingToolbar()).toBe(false);
    expect(set).toHaveBeenCalledWith({ key: PIN, value: 'false' });
  });

  it('keeps the defaults when storage is unavailable', async () => {
    get.mockRejectedValue(new Error('no storage'));
    const svc = build();

    await svc.init();

    expect(svc.showFormattingToolbar()).toBe(true);
    expect(svc.formatOnSelection()).toBe(true);
  });
});
