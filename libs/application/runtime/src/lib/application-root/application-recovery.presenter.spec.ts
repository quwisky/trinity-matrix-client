import { TestBed } from '@angular/core/testing';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  ACCOUNT_LIFECYCLE_PORT,
  ACCOUNT_REMOVAL_CONSEQUENCES,
  MENTION_HISTORY_LOSS,
  clearDataMessage,
} from '@trinity/data-access/accounts';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { ApplicationRecoveryPresenter } from './application-recovery.presenter';

function setup(hasHistory: boolean) {
  const confirm$ = vi.fn(() => of(true));
  const prompt$ = vi.fn(() => of<string | null>(null));
  const recover = vi.fn(() => of({ kind: 'accepted' as const }));
  const hasMentionHistory = vi.fn((_accountId?: string, _ifUnknown?: boolean) =>
    of(hasHistory),
  );
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      MockProvider(ApplicationRuntimeService, { recover }),
      MockProvider(TrnAlertService, { confirm$, prompt$ }),
      MockProvider(TrnToastService),
      { provide: ACCOUNT_LIFECYCLE_PORT, useValue: { hasMentionHistory } },
    ],
  });
  return {
    presenter: TestBed.inject(ApplicationRecoveryPresenter),
    confirm$,
    prompt$,
    recover,
    hasMentionHistory,
  };
}

describe('ApplicationRecoveryPresenter', () => {
  it('startup recovery adds the sentence when the device holds any', async () => {
    const { presenter, confirm$, recover, hasMentionHistory } = setup(true);

    await firstValueFrom(presenter.confirmAndRecover('reauthenticate'));

    // No account ID is exposed here, so it asks about the whole device. True on an unread count.
    expect(hasMentionHistory).toHaveBeenCalledExactlyOnceWith(undefined, true);
    expect(confirm$).toHaveBeenCalledExactlyOnceWith({
      header: 'Remove account and sign in again',
      message: `${ACCOUNT_REMOVAL_CONSEQUENCES}\n\n${MENTION_HISTORY_LOSS}`,
      confirmText: 'Remove account',
      cancelText: 'Cancel',
      variant: 'danger',
    });
    expect(recover).toHaveBeenCalledExactlyOnceWith('reauthenticate');
  });

  it('startup recovery leaves it out when the device holds none', async () => {
    const { presenter, confirm$ } = setup(false);

    await firstValueFrom(presenter.confirmAndRecover('reauthenticate'));

    expect(confirm$).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: ACCOUNT_REMOVAL_CONSEQUENCES }),
    );
  });

  it('Erase all data is unchanged', () => {
    const { presenter, prompt$, hasMentionHistory } = setup(true);

    presenter.confirmAndRecover('reset-installation').subscribe();

    expect(hasMentionHistory).not.toHaveBeenCalled();
    expect(prompt$).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: clearDataMessage(null) }),
    );
    expect(clearDataMessage(null)).not.toContain(MENTION_HISTORY_LOSS);
    expect(clearDataMessage(['@me:hs'])).not.toContain(MENTION_HISTORY_LOSS);
  });
});
