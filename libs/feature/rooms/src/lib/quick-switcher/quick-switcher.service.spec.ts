import { TestBed } from '@angular/core/testing';
import { type SwitcherSelection } from '@trinity/application/search';
import { TrnDialogService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, Subject } from 'rxjs';
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

  it('opens the switcher dialog and emits the chosen selection', async () => {
    const selection: SwitcherSelection = {
      kind: 'space',
      accountId: '@me:hs',
      spaceId: '!s:hs',
    };
    vi.mocked(dialog.openAndWait$).mockReturnValue(of(selection));

    const result = await firstValueFrom(svc.pick$());

    expect(dialog.openAndWait$).toHaveBeenCalledWith(QuickSwitcherComponent, {
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
    vi.mocked(dialog.openAndWait$).mockReturnValue(of(null));

    await firstValueFrom(svc.pick$({ activeAccountOnly: true }));

    expect(dialog.openAndWait$).toHaveBeenCalledWith(
      QuickSwitcherComponent,
      expect.objectContaining({ inputs: { activeAccountOnly: true } }),
    );
  });

  it('emits null when dismissed without a selection', async () => {
    vi.mocked(dialog.openAndWait$).mockReturnValue(of(null));
    expect(await firstValueFrom(svc.pick$())).toBeNull();
  });

  it('ignores a repeat trigger while a switcher is already open', async () => {
    const dismissed = new Subject<SwitcherSelection | null>();
    vi.mocked(dialog.openAndWait$).mockReturnValue(dismissed);

    const first = firstValueFrom(svc.pick$()); // opens; stays pending
    const second = await firstValueFrom(svc.pick$());

    expect(second).toBeNull();
    expect(dialog.openAndWait$).toHaveBeenCalledTimes(1);

    dismissed.next({
      kind: 'conversation',
      accountId: '@me:hs',
      roomId: '!r:hs',
    });
    dismissed.complete();
    await expect(first).resolves.toEqual({
      kind: 'conversation',
      accountId: '@me:hs',
      roomId: '!r:hs',
    });
  });
});
