import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/helm/overlay';
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

  it('opens the dialog for the message, on the requested key', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);

    await svc.open('$m', '🎉');

    expect(dialog.openAndWait).toHaveBeenCalledWith(ReactionsDialogComponent, {
      ariaLabel: 'Reactions',
      inputs: { eventId: '$m', initialKey: '🎉' },
    });
  });

  it('defaults to no particular key (the trailing chip)', async () => {
    vi.mocked(dialog.openAndWait).mockResolvedValue(null);

    await svc.open('$m');

    expect(dialog.openAndWait).toHaveBeenCalledWith(
      ReactionsDialogComponent,
      expect.objectContaining({ inputs: { eventId: '$m', initialKey: null } }),
    );
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
