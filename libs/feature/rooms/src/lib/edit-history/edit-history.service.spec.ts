import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '@trinity/components/overlay';
import { EditHistoryDialogService } from './edit-history.service';
import { EditHistoryComponent } from './edit-history.component';
import { type MatrixLinkClickTarget } from '../matrix-link/matrix-link.directive';

function setup(result: MatrixLinkClickTarget | null | 'pending' = null) {
  const pending = new Subject<MatrixLinkClickTarget | null>();
  const openAndWait$ = vi.fn(() =>
    result === 'pending' ? pending : of(result),
  );
  TestBed.configureTestingModule({
    providers: [
      EditHistoryDialogService,
      MockProvider(TrnDialogService, {
        openAndWait$: openAndWait$ as TrnDialogService['openAndWait$'],
      }),
    ],
  });
  return {
    svc: TestBed.inject(EditHistoryDialogService),
    openAndWait$,
    release: (value: MatrixLinkClickTarget | null) => {
      pending.next(value);
      pending.complete();
    },
  };
}

describe('EditHistoryDialogService', () => {
  it('opens the dialog for the message and emits a followed permalink', async () => {
    const target = { kind: 'user' as const, userId: '@bob:hs' };
    const { svc, openAndWait$ } = setup(target);

    const followed = await firstValueFrom(svc.openHistory$('!r:hs', '$orig'));

    expect(openAndWait$).toHaveBeenCalledWith(
      EditHistoryComponent,
      expect.objectContaining({
        ariaLabel: 'Edit history',
        inputs: { roomId: '!r:hs', eventId: '$orig' },
      }),
    );
    expect(followed).toEqual(target);
  });

  it('ignores a repeat trigger instead of stacking dialogs', async () => {
    const { svc, openAndWait$, release } = setup('pending');

    const first = firstValueFrom(svc.openHistory$('!r:hs', '$orig'));
    const second = await firstValueFrom(svc.openHistory$('!r:hs', '$orig'));

    expect(second).toBeNull();
    expect(openAndWait$).toHaveBeenCalledOnce();

    release(null);
    await first;
  });

  // The guard has to clear, or the dialog would open once per session and then quietly
  // never again.
  it('can be opened again after it closes', async () => {
    const { svc, openAndWait$ } = setup(null);

    await firstValueFrom(svc.openHistory$('!r:hs', '$a'));
    await firstValueFrom(svc.openHistory$('!r:hs', '$b'));

    expect(openAndWait$).toHaveBeenCalledTimes(2);
  });

  it('clears the guard even when the dialog throws', async () => {
    const { svc, openAndWait$ } = setup(null);
    openAndWait$.mockReturnValueOnce(
      throwError(() => new Error('overlay exploded')),
    );

    await expect(
      firstValueFrom(svc.openHistory$('!r:hs', '$a')),
    ).rejects.toThrow();
    await firstValueFrom(svc.openHistory$('!r:hs', '$a'));

    expect(openAndWait$).toHaveBeenCalledTimes(2);
  });
});
