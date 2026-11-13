import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnToastService } from '@trinity/components/overlay';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import {
  TrustOperationError,
  TrustService,
  TrustUsersService,
  TrustVerificationService,
} from '@trinity/data-access/trust';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { IdentityChangeActionsService } from './identity-change-actions.service';

const BOB = { userId: '@bob:hs', name: 'Bob' };

describe('IdentityChangeActionsService', () => {
  let acknowledgeIdentity: Mock;
  let withdrawVerification: Mock;
  let startUserVerification: Mock;
  let show: Mock;
  const canSignUsers = signal<boolean | null>(null);
  const dm = of('!dm:hs');

  beforeEach(() => {
    acknowledgeIdentity = vi.fn(() => of(undefined));
    withdrawVerification = vi.fn(() => of(undefined));
    startUserVerification = vi.fn(() => of(undefined));
    show = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        MockProvider(TrustService, { canSignUsers }),
        MockProvider(TrustUsersService, {
          acknowledgeIdentity,
          withdrawVerification,
        }),
        MockProvider(TrustVerificationService, { startUserVerification }),
        MockProvider(RoomLibraryService, { createDirectMessage: () => dm }),
        MockProvider(TrnToastService, { show }),
      ],
    });
  });

  const service = () => TestBed.inject(IdentityChangeActionsService);

  it('acknowledges and withdraws through Trust', () => {
    service().acknowledge(BOB);
    service().withdraw(BOB);

    expect(acknowledgeIdentity).toHaveBeenCalledWith('@bob:hs');
    expect(withdrawVerification).toHaveBeenCalledWith('@bob:hs');
    expect(show).not.toHaveBeenCalled();
  });

  it('verifies again over a DM with them and says when it started', () => {
    const started = vi.fn();
    service().verifyAgain(BOB, started);

    expect(startUserVerification).toHaveBeenCalledWith('@bob:hs', dm);
    expect(started).toHaveBeenCalledOnce();
  });

  // Unknown is not blocked: Trust itself refuses at the moment of use.
  it.each([
    [false, true],
    [true, false],
    [null, false],
  ])('with canSignUsers %s, verifying is blocked: %s', (can, blocked) => {
    canSignUsers.set(can);

    expect(service().verifyBlocked()).toBe(blocked);
  });

  it('names the running action and runs one at a time per person', () => {
    const pending = new Subject<void>();
    acknowledgeIdentity.mockReturnValue(pending);

    service().acknowledge(BOB);
    expect(service().pending('@bob:hs')).toBe('acknowledge');
    service().acknowledge(BOB);
    expect(acknowledgeIdentity).toHaveBeenCalledOnce();

    pending.complete();
    expect(service().pending('@bob:hs')).toBeNull();
  });

  it('names the person in a failure toast', () => {
    withdrawVerification.mockReturnValue(
      throwError(
        () =>
          new TrustOperationError(
            'withdraw-verification',
            'server-failure',
            'retry',
            'x',
          ),
      ),
    );

    service().withdraw(BOB);

    expect(show).toHaveBeenCalledWith(
      "Couldn't withdraw verification for Bob.",
      expect.objectContaining({ variant: 'danger' }),
    );
    expect(service().pending('@bob:hs')).toBeNull();
  });
});
