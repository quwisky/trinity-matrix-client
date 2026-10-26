import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { TrustService } from '@trinity/data-access/trust';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  InviteHistoryNoteService,
  inviteHistoryNote,
} from './invite-history-note';
import {
  UndecryptableFixService,
  type UndecryptableFix,
} from './undecryptable-fix.service';

describe('inviteHistoryNote', () => {
  it.each([
    [
      'shared',
      true,
      "If they've set up encryption, they'll be able to read earlier messages.",
      false,
    ],
    [
      'shared',
      false,
      'Verify this device before inviting, so they can read earlier messages.',
      true,
    ],
    [
      'from-invite',
      false,
      "They'll be able to read messages from when they're invited.",
      false,
    ],
    [
      'from-join',
      true,
      "They'll be able to read messages sent after they join.",
      false,
    ],
  ] as const)(
    '%s history, device verified %s',
    (history, verified, text, needsVerification) => {
      expect(inviteHistoryNote(history, verified)).toEqual({
        text,
        needsVerification,
      });
    },
  );

  it('says nothing for an unencrypted room or an unknown device state', () => {
    expect(inviteHistoryNote(null, true)).toBeNull();
    expect(inviteHistoryNote('shared', null)).toBeNull();
  });
});

describe('InviteHistoryNoteService', () => {
  const VERIFY: UndecryptableFix = {
    label: 'Verify this device',
    target: 'setup',
  };

  function setup(verified: boolean | null, fix: UndecryptableFix | null) {
    const open = vi.fn(() => of(undefined));
    const inviteHistory = vi.fn(() => 'shared' as const);
    TestBed.configureTestingModule({
      providers: [
        MockProvider(RoomLibraryService, { inviteHistory }),
        MockProvider(TrustService, {
          thisDeviceVerified: signal(verified),
        }),
        MockProvider(UndecryptableFixService, { fix: signal(fix), open }),
        MockProvider(WorkspaceNavigationService, {
          activeAccountId: signal('@me:hs'),
        }),
      ],
    });
    return {
      service: TestBed.inject(InviteHistoryNoteService),
      open,
      inviteHistory,
    };
  }

  it('offers the device fix when history cannot be shared yet', () => {
    const { service, open, inviteHistory } = setup(false, VERIFY);
    const key = { accountId: '@me:hs', roomId: '!r:hs' };

    const note = service.noteFor(key);

    expect(inviteHistory).toHaveBeenCalledWith(key);
    expect(note?.action?.label).toBe('Verify this device');
    note?.action?.run();
    expect(open).toHaveBeenCalledOnce();
  });

  it('has no button once the device is verified', () => {
    const { service } = setup(true, null);

    expect(service.noteFor('!r:hs')).toEqual({
      text: "If they've set up encryption, they'll be able to read earlier messages.",
    });
  });

  it("says nothing about shared history from another account's invite", () => {
    const { service } = setup(true, null);

    expect(
      service.noteFor({ accountId: '@other:hs', roomId: '!r:hs' }),
    ).toBeNull();
  });

  it('shows the text without a button when there is no fix to offer', () => {
    const { service } = setup(false, null);

    expect(service.noteFor('!r:hs')).toEqual({
      text: 'Verify this device before inviting, so they can read earlier messages.',
    });
  });
});
