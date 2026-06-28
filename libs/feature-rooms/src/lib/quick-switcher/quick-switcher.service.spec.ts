import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular/standalone';
import type { SwitcherSelection } from '@trinity/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickSwitcherComponent } from './quick-switcher.component';
import { QuickSwitcherService } from './quick-switcher.service';

describe('QuickSwitcherService', () => {
  let create: ReturnType<typeof vi.fn>;
  let present: ReturnType<typeof vi.fn>;
  let svc: QuickSwitcherService;

  beforeEach(() => {
    present = vi.fn().mockResolvedValue(undefined);
    create = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        QuickSwitcherService,
        { provide: ModalController, useValue: { create } },
      ],
    });
    svc = TestBed.inject(QuickSwitcherService);
  });

  it('presents the switcher modal and resolves the chosen selection', async () => {
    const selection: SwitcherSelection = { kind: 'space', id: '!s:hs' };
    create.mockResolvedValue({
      present,
      onWillDismiss: () => Promise.resolve({ data: selection }),
    });

    const result = await svc.pick();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        component: QuickSwitcherComponent,
        cssClass: 'quick-switcher-modal',
      }),
    );
    expect(present).toHaveBeenCalled();
    expect(result).toEqual(selection);
  });

  it('resolves null when dismissed without a selection', async () => {
    create.mockResolvedValue({
      present,
      onWillDismiss: () => Promise.resolve({ data: undefined }),
    });

    expect(await svc.pick()).toBeNull();
  });

  it('ignores a repeat trigger while a switcher is already open', async () => {
    // The deferred is built up front so its resolver exists regardless of when the
    // first pick reaches onWillDismiss (avoids a microtask-ordering race in the test).
    let release!: (value: { data: SwitcherSelection | null }) => void;
    const dismissed = new Promise<{ data: SwitcherSelection | null }>(
      (resolve) => {
        release = resolve;
      },
    );
    create.mockResolvedValue({ present, onWillDismiss: () => dismissed });

    const first = svc.pick(); // opens; stays pending on onWillDismiss
    const second = await svc.pick(); // re-entrant: no second modal

    expect(second).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);

    release({ data: { kind: 'room', id: '!r:hs' } });
    await expect(first).resolves.toEqual({ kind: 'room', id: '!r:hs' });
  });
});
