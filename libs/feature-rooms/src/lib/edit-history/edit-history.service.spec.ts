import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '@trinity/helm/overlay';
import { EditHistoryDialogService } from './edit-history.service';
import { EditHistoryComponent } from './edit-history.component';

function setup(result: unknown = null) {
  let release: ((value: unknown) => void) | null = null;
  const openAndWait = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
        if (result !== 'pending') {
          resolve(result);
        }
      }),
  );
  TestBed.configureTestingModule({
    providers: [
      EditHistoryDialogService,
      MockProvider(TrnDialogService, { openAndWait }),
    ],
  });
  return {
    svc: TestBed.inject(EditHistoryDialogService),
    openAndWait,
    release: (value: unknown) => release?.(value),
  };
}

describe('EditHistoryDialogService', () => {
  it('opens the dialog for the message and resolves a followed permalink', async () => {
    const target = { kind: 'user', userId: '@bob:hs' };
    const { svc, openAndWait } = setup(target);

    const followed = await svc.openHistory('!r:hs', '$orig');

    expect(openAndWait).toHaveBeenCalledWith(
      EditHistoryComponent,
      expect.objectContaining({
        ariaLabel: 'Edit history',
        inputs: { roomId: '!r:hs', eventId: '$orig' },
      }),
    );
    expect(followed).toEqual(target);
  });

  it('ignores a repeat trigger instead of stacking dialogs', async () => {
    const { svc, openAndWait, release } = setup('pending');

    const first = svc.openHistory('!r:hs', '$orig');
    const second = await svc.openHistory('!r:hs', '$orig');

    expect(second).toBeNull();
    expect(openAndWait).toHaveBeenCalledOnce();

    release(null);
    await first;
  });

  // The guard has to clear, or the dialog would open once per session and then quietly
  // never again.
  it('can be opened again after it closes', async () => {
    const { svc, openAndWait } = setup(null);

    await svc.openHistory('!r:hs', '$a');
    await svc.openHistory('!r:hs', '$b');

    expect(openAndWait).toHaveBeenCalledTimes(2);
  });

  it('clears the guard even when the dialog throws', async () => {
    const { svc, openAndWait } = setup(null);
    openAndWait.mockRejectedValueOnce(new Error('overlay exploded'));

    await expect(svc.openHistory('!r:hs', '$a')).rejects.toThrow();
    await svc.openHistory('!r:hs', '$a');

    expect(openAndWait).toHaveBeenCalledTimes(2);
  });
});
