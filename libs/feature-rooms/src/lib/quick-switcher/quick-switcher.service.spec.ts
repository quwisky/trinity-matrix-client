import { TestBed } from '@angular/core/testing';
import type { SwitcherSelection } from '@trinity/core';
import { TrnDialogService } from '@trinity/ui-spartan';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickSwitcherComponent } from './quick-switcher.component';
import { QuickSwitcherService } from './quick-switcher.service';

describe('QuickSwitcherService', () => {
  let openAndWait: ReturnType<typeof vi.fn>;
  let svc: QuickSwitcherService;

  beforeEach(() => {
    openAndWait = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        QuickSwitcherService,
        { provide: TrnDialogService, useValue: { openAndWait } },
      ],
    });
    svc = TestBed.inject(QuickSwitcherService);
  });

  it('opens the switcher dialog and resolves the chosen selection', async () => {
    const selection: SwitcherSelection = { kind: 'space', id: '!s:hs' };
    openAndWait.mockResolvedValue(selection);

    const result = await svc.pick();

    expect(openAndWait).toHaveBeenCalledWith(QuickSwitcherComponent);
    expect(result).toEqual(selection);
  });

  it('resolves null when dismissed without a selection', async () => {
    openAndWait.mockResolvedValue(null);
    expect(await svc.pick()).toBeNull();
  });

  it('ignores a repeat trigger while a switcher is already open', async () => {
    // Controlled pending promise so the first pick stays open across the re-entry.
    let release!: (value: SwitcherSelection | null) => void;
    const dismissed = new Promise<SwitcherSelection | null>((resolve) => {
      release = resolve;
    });
    openAndWait.mockReturnValue(dismissed);

    const first = svc.pick(); // opens; stays pending
    const second = await svc.pick(); // re-entrant: no second dialog

    expect(second).toBeNull();
    expect(openAndWait).toHaveBeenCalledTimes(1);

    release({ kind: 'room', id: '!r:hs' });
    await expect(first).resolves.toEqual({ kind: 'room', id: '!r:hs' });
  });
});
