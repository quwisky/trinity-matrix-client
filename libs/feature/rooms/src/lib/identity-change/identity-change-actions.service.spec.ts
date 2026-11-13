import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnToastService } from '@trinity/components/overlay';
import { IdentityService } from '@trinity/data-access/identity';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import {
  TrustOperationError,
  TrustUsersService,
  TrustVerificationService,
} from '@trinity/data-access/trust';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { IdentityChangeActionsService } from './identity-change-actions.service';

const BOB = { accountId: '@me:hs', userId: '@bob:hs', name: 'Bob' };

describe('IdentityChangeActionsService', () => {
  let acknowledgeIdentity: Mock;
  let withdrawVerification: Mock;
  let startUserVerification: Mock;
  let show: Mock;
  const dm = of('!dm:hs');
  /** The Account the banner and its lists show, and the one the client acts as. */
  let shownAccountId: ReturnType<typeof signal<string | null>>;
  let clientAccountId: ReturnType<typeof signal<string | null>>;

  beforeEach(() => {
    acknowledgeIdentity = vi.fn(() => of(undefined));
    withdrawVerification = vi.fn(() => of(undefined));
    startUserVerification = vi.fn(() => of(undefined));
    show = vi.fn();
    shownAccountId = signal<string | null>('@me:hs');
    clientAccountId = signal<string | null>('@me:hs');
    TestBed.configureTestingModule({
      providers: [
        MockProvider(TrustUsersService, {
          acknowledgeIdentity,
          withdrawVerification,
        }),
        MockProvider(TrustVerificationService, { startUserVerification }),
        MockProvider(RoomLibraryService, { createDirectMessage: () => dm }),
        MockProvider(TrnToastService, { show }),
        MockProvider(WorkspaceNavigationService, {
          activeAccountId: shownAccountId.asReadonly(),
        }),
        MockProvider(IdentityService, {
          activeUserId: clientAccountId.asReadonly(),
        }),
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

  describe('once both the client and the shown account are another one, before the row is gone', () => {
    beforeEach(() => {
      clientAccountId.set('@other:hs');
      shownAccountId.set('@other:hs');
    });

    it('does not start verification, or a DM, as the new account', () => {
      const started = vi.fn();
      service().verifyAgain(BOB, started);

      expect(startUserVerification).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledWith(
        'Verification not started: you switched account while this was open.',
        expect.objectContaining({ variant: 'danger' }),
      );
    });

    it('does not accept or withdraw as the new account', () => {
      service().acknowledge(BOB);
      service().withdraw(BOB);

      expect(acknowledgeIdentity).not.toHaveBeenCalled();
      expect(withdrawVerification).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledWith(
        'Identity not accepted: you switched account while this was open.',
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(show).toHaveBeenCalledWith(
        'Verification not withdrawn: you switched account while this was open.',
        expect.objectContaining({ variant: 'danger' }),
      );
    });
  });

  describe('once the client has switched account, before the shown one follows', () => {
    beforeEach(() => clientAccountId.set('@other:hs'));

    it('does not start verification, or a DM, as the new account', () => {
      const started = vi.fn();
      service().verifyAgain(BOB, started);

      expect(startUserVerification).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledWith(
        'Verification not started: you switched account while this was open.',
        expect.objectContaining({ variant: 'danger' }),
      );
    });

    it('does not accept or withdraw as the new account', () => {
      service().acknowledge(BOB);
      service().withdraw(BOB);

      expect(acknowledgeIdentity).not.toHaveBeenCalled();
      expect(withdrawVerification).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledWith(
        'Identity not accepted: you switched account while this was open.',
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(show).toHaveBeenCalledWith(
        'Verification not withdrawn: you switched account while this was open.',
        expect.objectContaining({ variant: 'danger' }),
      );
    });
  });
});
