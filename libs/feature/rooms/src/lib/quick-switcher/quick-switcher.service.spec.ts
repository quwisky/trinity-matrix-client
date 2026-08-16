import { TestBed } from '@angular/core/testing';
import { type SwitcherSelection } from '@trinity/data-access/search';
import { TrnDialogService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickSwitcherComponent } from './quick-switcher.component';
import { QuickSwitcherService } from './quick-switcher.service';

describe('QuickSwitcherService', () => {
  let dialog: TrnDialogService;
  let svc: QuickSwitcherService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [QuickSwitcherService, MockProvider(TrnDialogService)],
    });
    dialog = TestBed.inject(TrnDialogService);
    svc = TestBed.inject(QuickSwitcherService);
  });

  it('opens the switcher dialog and resolves the chosen selection', async () => {
    const selection: SwitcherSelection = { kind: 'space', id: '!s:hs' };
    vi.mocked(dialog.openAndWait).mockResolvedValue(selection);

    const result = await svc.pick();

    expect(dialog.openAndWait).toHaveBeenCalledWith(QuickSwitcherComponent, {
      ariaLabel: 'Jump to a room',
      // Names the search field so CDK doesn't focus the Cancel button instead.
      autoFocus: '[data-autofocus]',
      inputs: { activeAccountOnly: false },
    });
    expect(result).toEqual(selection);
  });

  // Forwarding sends through the ACTIVE client without switching accounts, so its picker
  // must not offer a mixed-in account's room (an unpostable 403 destination).
  it('scopes the list to the active account when the caller asks for it', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);

    await svc.pick({ activeAccountOnly: true });

    expect(dialog.openAndWait).toHaveBeenCalledWith(
      QuickSwitcherComponent,
      expect.objectContaining({ inputs: { activeAccountOnly: true } }),
    );
  });

  it('resolves null when dismissed without a selection', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);
    expect(await svc.pick()).toBeNull();
  });

  it('ignores a repeat trigger while a switcher is already open', async () => {
    // Controlled pending promise so the first pick stays open across the re-entry.
    let release!: (value: SwitcherSelection | null) => void;
    const dismissed = new Promise<SwitcherSelection | null>((resolve) => {
      release = resolve;
    });
    vi.mocked(dialog.openAndWait).mockReturnValue(dismissed);

    const first = svc.pick(); // opens; stays pending
    const second = await svc.pick(); // re-entrant: no second dialog

    expect(second).toBeNull();
    expect(dialog.openAndWait).toHaveBeenCalledTimes(1);

    release({ kind: 'room', id: '!r:hs' });
    await expect(first).resolves.toEqual({ kind: 'room', id: '!r:hs' });
  });
});
