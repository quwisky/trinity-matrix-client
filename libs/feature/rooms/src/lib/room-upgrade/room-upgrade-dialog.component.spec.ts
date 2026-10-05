import { render } from '@trinity/testing';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import {
  RoomAdministrationError,
  RoomUpgradeService,
  type RoomUpgradePlan,
  type RoomUpgradeResult,
} from '@trinity/data-access/room-administration';
import { MockProvider } from 'ng-mocks';
import { Subject, defer } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  ROOM_UPGRADE_WARNING_ID,
  RoomUpgradeDialogComponent,
  preselectedTarget,
  upgradeErrorMessage,
  upgradeSummary,
} from './room-upgrade-dialog.component';

const PLAN: RoomUpgradePlan = {
  currentVersion: '10',
  targets: [
    { version: '11', isDefault: true },
    { version: '12', isDefault: false },
  ],
  invitePrivateDefault: true,
  members: ['@bob:hs', '@carol:hs'],
  spaces: [
    { spaceId: '!design:hs', name: 'Design', relinkable: true },
    {
      spaceId: '!ops:hs',
      name: 'Ops',
      relinkable: false,
      reason: 'no permission',
    },
  ],
  additionalCreators: [],
  additionalCreatorNames: [],
};

const RESULT: RoomUpgradeResult = {
  newRoomId: '!new:hs',
  invited: ['@bob:hs', '@carol:hs'],
  inviteFailed: [],
  relinked: ['!design:hs'],
  relinkFailed: [],
  skippedSpaces: [PLAN.spaces[1]],
};

async function build(plan: RoomUpgradePlan = PLAN) {
  const runs = new Subject<RoomUpgradeResult>();
  const upgrade = vi.fn(() => runs.asObservable());
  const close = vi.fn();
  const show = vi.fn();
  const rendered = await render(RoomUpgradeDialogComponent, {
    inputs: { accountId: '@me:hs', roomId: '!old:hs', plan },
    providers: [
      MockProvider(RoomUpgradeService, { upgrade }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  const byTestId = (id: string) =>
    rendered.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const text = (id: string) =>
    byTestId(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const settle = () => rendered.fixture.detectChanges(); // zoneless
  const submit = () => {
    byTestId('room-upgrade-confirm')!.click();
    settle();
  };
  const inviteBox = () =>
    byTestId('room-upgrade-invite')?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    ) ?? null;
  return {
    ...rendered,
    runs,
    upgrade,
    close,
    show,
    byTestId,
    text,
    settle,
    submit,
    inviteBox,
  };
}

describe('preselectedTarget', () => {
  it('is the server default when it is offered, else the highest', () => {
    expect(preselectedTarget(PLAN.targets)).toBe('11');
    expect(
      preselectedTarget([
        { version: '11', isDefault: false },
        { version: '12', isDefault: false },
      ]),
    ).toBe('12');
    expect(preselectedTarget([])).toBe('');
  });
});

describe('upgradeSummary', () => {
  const name = (spaceId: string) =>
    ({ '!design:hs': 'Design', '!ops:hs': 'Ops' })[spaceId] ?? spaceId;

  it('says the room was upgraded when everything landed', () => {
    expect(upgradeSummary(RESULT, name)).toEqual({
      message: 'Room upgraded.',
      options: { variant: 'success' },
    });
  });

  it('counts and names what to retry, and stays until dismissed', () => {
    expect(
      upgradeSummary(
        {
          ...RESULT,
          invited: [],
          inviteFailed: [
            { userId: '@bob:hs', reason: 'x' },
            { userId: '@carol:hs', reason: 'y' },
          ],
          relinked: [],
          relinkFailed: [
            { spaceId: '!design:hs', reason: 'z', linkedTwice: true },
          ],
        },
        name,
      ),
    ).toEqual({
      message:
        'Upgraded; 2 invites and 1 space link failed. Invite again: @bob:hs and @carol:hs. Remove the old room from: Design.',
      options: {
        variant: 'warning',
        duration: 0,
        action: { label: 'Dismiss', onClick: expect.any(Function) },
      },
    });
    expect(
      upgradeSummary(
        {
          ...RESULT,
          relinked: [],
          relinkFailed: [
            { spaceId: '!design:hs', reason: 'z', linkedTwice: false },
            { spaceId: '!ops:hs', reason: 'z', linkedTwice: false },
          ],
        },
        name,
      ).message,
    ).toBe(
      'Upgraded; 2 space links failed. Add the new room to: Design and Ops.',
    );
  });
});

describe('upgradeErrorMessage', () => {
  it('names the server’s reason, or the lost permission', () => {
    expect(upgradeErrorMessage(new Error('M_UNSUPPORTED_ROOM_VERSION'))).toBe(
      'The server could not upgrade the room (M_UNSUPPORTED_ROOM_VERSION). Nothing was changed.',
    );
    expect(
      upgradeErrorMessage(
        new RoomAdministrationError(
          {
            kind: 'rejected',
            failure: 'permission-denied',
            recovery: 'refresh-authority',
            operation: 'authorize-room-action',
          },
          'nope',
        ),
      ),
    ).toBe('You can no longer upgrade this room. Nothing was changed.');
    expect(
      upgradeErrorMessage(
        new RoomAdministrationError(
          {
            kind: 'rejected',
            failure: 'invalid-input',
            recovery: 'retry-operation',
            operation: 'upgrade-room',
          },
          'already upgraded',
        ),
      ),
    ).toBe('This room has already been upgraded. Nothing was changed.');
  });
});

describe('RoomUpgradeDialogComponent', () => {
  it('shows the warning and the version picker with the default labelled', async () => {
    const { text, fixture } = await build();

    expect(text('room-upgrade-warning')).toBe(
      'Upgrading creates a new room and closes this one. Members need to join the new room; the old room stays readable with a link to the new one.',
    );
    expect(fixture.componentInstance.versionOptions()).toEqual([
      {
        value: '11',
        label: '11 (server default)',
        testId: 'room-upgrade-version-11',
      },
      { value: '12', label: '12', testId: 'room-upgrade-version-12' },
    ]);
  });

  it('gives the warning the id the opener points aria-describedby at', async () => {
    const { byTestId } = await build();

    expect(byTestId('room-upgrade-warning')?.id).toBe(ROOM_UPGRADE_WARNING_ID);
  });

  it('upgrades to the preselected server default and invites a private room’s members', async () => {
    const { submit, upgrade, inviteBox, text } = await build();

    // toContain: the checkbox renders its ✓ glyph inside the same label.
    expect(text('room-upgrade-invite')).toContain('Invite current members (2)');
    expect(inviteBox()?.checked).toBe(true);
    submit();

    expect(upgrade).toHaveBeenCalledWith('@me:hs', '!old:hs', {
      version: '11',
      inviteMembers: true,
    });
  });

  it('starts on the highest version when the default is not newer', async () => {
    const { submit, upgrade } = await build({
      ...PLAN,
      targets: [
        { version: '11', isDefault: false },
        { version: '12', isDefault: false },
      ],
    });

    submit();

    expect(upgrade).toHaveBeenCalledWith('@me:hs', '!old:hs', {
      version: '12',
      inviteMembers: true,
    });
  });

  it('leaves invites off for a public room until ticked', async () => {
    const { submit, upgrade, inviteBox, settle } = await build({
      ...PLAN,
      invitePrivateDefault: false,
    });

    expect(inviteBox()?.checked).toBe(false);
    inviteBox()!.click();
    settle();
    submit();

    expect(upgrade).toHaveBeenCalledWith('@me:hs', '!old:hs', {
      version: '11',
      inviteMembers: true,
    });
  });

  it('hides the invite and sends none when nobody else is in the room', async () => {
    const { submit, upgrade, byTestId } = await build({ ...PLAN, members: [] });

    expect(byTestId('room-upgrade-invite')).toBeNull();
    submit();

    expect(upgrade).toHaveBeenCalledWith('@me:hs', '!old:hs', {
      version: '11',
      inviteMembers: false,
    });
  });

  it('lists the spaces that will and will not be re-linked', async () => {
    const { container } = await build();

    expect(
      [...container.querySelectorAll('[data-testid="room-upgrade-space"]')].map(
        (el) => el.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual([
      'Design Will be re-linked',
      "Ops Can't re-link — no permission",
    ]);
  });

  it('hides the spaces list when no space links the room', async () => {
    const { container } = await build({ ...PLAN, spaces: [] });

    expect(container.textContent).not.toContain('Spaces');
    expect(
      container.querySelector('[data-testid="room-upgrade-space"]'),
    ).toBeNull();
  });

  it('is busy, announced and runs once while upgrading', async () => {
    const { submit, upgrade, byTestId, container, fixture } = await build();

    submit();
    submit();

    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.busy()).toBe(true);
    const confirm = byTestId('room-upgrade-confirm') as HTMLButtonElement;
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(confirm.disabled).toBe(true);
    expect(
      (byTestId('room-upgrade-cancel') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      container.querySelector('[role="status"]')?.textContent?.trim(),
    ).toBe('Upgrading the room…');
  });

  it('subscribes once when submitted twice before the view updates', async () => {
    const { fixture, upgrade } = await build();
    let subscriptions = 0;
    upgrade.mockImplementation(() =>
      defer(() => {
        subscriptions += 1;
        return new Subject<RoomUpgradeResult>();
      }),
    );

    fixture.componentInstance.upgrade();
    fixture.componentInstance.upgrade();

    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(subscriptions).toBe(1);
  });

  it('disables the version picker while upgrading', async () => {
    const { byTestId, submit } = await build();
    const select = () =>
      byTestId('room-upgrade-version')!.querySelector('button, select');

    expect(select()?.hasAttribute('disabled')).toBe(false);
    submit();

    expect(select()?.hasAttribute('disabled')).toBe(true);
  });

  it('toasts and closes with the result', async () => {
    const { submit, runs, show, close, settle } = await build();

    submit();
    runs.next(RESULT);
    settle();

    expect(show).toHaveBeenCalledWith('Room upgraded.', { variant: 'success' });
    expect(close).toHaveBeenCalledWith(RESULT);
  });

  it('toasts a partial failure with what to retry', async () => {
    const { submit, runs, show, settle } = await build();

    submit();
    runs.next({
      ...RESULT,
      invited: ['@carol:hs'],
      inviteFailed: [{ userId: '@bob:hs', reason: 'x' }],
      relinked: [],
      relinkFailed: [
        { spaceId: '!design:hs', reason: 'y', linkedTwice: false },
      ],
    });
    settle();

    expect(show).toHaveBeenCalledWith(
      'Upgraded; 1 invite and 1 space link failed. Invite again: @bob:hs. Add the new room to: Design.',
      {
        variant: 'warning',
        duration: 0,
        action: { label: 'Dismiss', onClick: expect.any(Function) },
      },
    );
  });

  const withCreators = {
    ...PLAN,
    additionalCreators: ['@alice:hs'],
    additionalCreatorNames: ['Alice'],
  };

  it('lists the new room’s creators for version 12', async () => {
    const { text } = await build({
      ...withCreators,
      targets: [{ version: '12', isDefault: true }],
    });

    expect(text('room-upgrade-creators')).toBe(
      'Creators of the new room: you, Alice',
    );
  });

  it('hides the creators for version 11', async () => {
    const { byTestId } = await build({
      ...withCreators,
      targets: [{ version: '11', isDefault: true }],
    });

    expect(byTestId('room-upgrade-creators')).toBeNull();
  });

  it('shows a rejected upgrade inline and stays open', async () => {
    const { submit, runs, close, text, byTestId, settle, fixture } =
      await build();

    submit();
    runs.error(
      new RoomAdministrationError(
        {
          kind: 'rejected',
          failure: 'server-rejected',
          recovery: 'retry-operation',
          operation: 'upgrade-room',
        },
        'M_UNSUPPORTED_ROOM_VERSION',
      ),
    );
    settle();

    expect(text('room-upgrade-error')).toBe(
      'The server could not upgrade the room (M_UNSUPPORTED_ROOM_VERSION). Nothing was changed.',
    );
    expect(close).not.toHaveBeenCalled();
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(
      (byTestId('room-upgrade-confirm') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('closes with nothing on Cancel', async () => {
    const { byTestId, close } = await build();

    byTestId('room-upgrade-cancel')!.click();

    expect(close).toHaveBeenCalledWith();
  });
});
