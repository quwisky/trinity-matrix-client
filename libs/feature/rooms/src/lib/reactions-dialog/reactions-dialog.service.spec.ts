import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactionsDialogComponent } from './reactions-dialog.component';
import { ReactionsDialogService } from './reactions-dialog.service';

describe('ReactionsDialogService', () => {
  let dialog: TrnDialogService;
  let svc: ReactionsDialogService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ReactionsDialogService, MockProvider(TrnDialogService)],
    });
    dialog = TestBed.inject(TrnDialogService);
    svc = TestBed.inject(ReactionsDialogService);
  });

  it('opens the dialog for the message', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);

    await svc.open('$m');

    expect(dialog.openAndWait).toHaveBeenCalledWith(ReactionsDialogComponent, {
      ariaLabel: 'Reactions',
      inputs: { eventId: '$m' },
    });
  });

  it('ignores a repeat trigger while one is already open', async () => {
    let release!: (value: null) => void;
    vi.mocked(dialog.openAndWait).mockReturnValue(
      new Promise<null>((resolve) => {
        release = resolve;
      }),
    );

    const first = svc.open('$m');
    await svc.open('$m'); // re-entrant: no second dialog

    expect(dialog.openAndWait).toHaveBeenCalledTimes(1);
    release(null);
    await first;
  });
});
