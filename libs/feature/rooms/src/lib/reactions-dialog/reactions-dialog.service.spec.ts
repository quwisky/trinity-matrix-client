import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactionsDialogComponent } from './reactions-dialog.component';
import { ReactionsDialogService } from './reactions-dialog.service';
import { of, Subject } from 'rxjs';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

describe('ReactionsDialogService', () => {
  let dialog: TrnDialogService;
  let svc: ReactionsDialogService;

  beforeEach(() => {
    platform.mobile = false;
    TestBed.configureTestingModule({
      providers: [ReactionsDialogService, MockProvider(TrnDialogService)],
    });
    dialog = TestBed.inject(TrnDialogService);
    svc = TestBed.inject(ReactionsDialogService);
  });

  it('opens the dialog for the message', () => {
    vi.mocked(dialog.openAndWait$).mockReturnValue(of(void 0));

    const command$ = svc.open$('$m');
    expect(dialog.openAndWait$).not.toHaveBeenCalled();
    command$.subscribe();

    expect(dialog.openAndWait$).toHaveBeenCalledWith(ReactionsDialogComponent, {
      ariaLabel: 'Reactions',
      placement: 'center',
      inputs: { eventId: '$m', sheet: false },
    });
  });

  it('chooses the bottom sheet on mobile when the cold command is subscribed', () => {
    platform.mobile = true;
    vi.mocked(dialog.openAndWait$).mockReturnValue(of(void 0));

    svc.open$('$m').subscribe();

    expect(dialog.openAndWait$).toHaveBeenCalledWith(ReactionsDialogComponent, {
      ariaLabel: 'Reactions',
      placement: 'bottom',
      inputs: { eventId: '$m', sheet: true },
    });
  });

  it('ignores a repeat trigger while one is already open', () => {
    const closed = new Subject<void>();
    vi.mocked(dialog.openAndWait$).mockReturnValue(closed);

    const first = svc.open$('$m').subscribe();
    const second = svc.open$('$m').subscribe();

    expect(dialog.openAndWait$).toHaveBeenCalledTimes(1);
    closed.next();
    closed.complete();
    first.unsubscribe();
    second.unsubscribe();
  });
});
