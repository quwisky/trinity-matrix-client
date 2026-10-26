import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  RoomPermissionsService,
  type PermissionRow,
  type PermissionRowView,
  type RoomPermissionsView,
} from '@trinity/data-access/room-administration';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsSettingsComponent } from './permissions-settings.component';

const row = (
  id: string,
  label: string,
  group: PermissionRow['group'],
): PermissionRow => ({ id, label, group, writes: [] });

const rowView = (
  r: PermissionRow,
  level: PermissionRowView['level'],
  extra: Partial<PermissionRowView> = {},
): PermissionRowView => ({
  row: r,
  level,
  editable: true,
  reason: null,
  ...extra,
});

const SEND = row('send-messages', 'Send messages', 'Messages');
const INVITE = row('invite', 'Invite', 'Members');
const BAN = row('ban', 'Ban', 'Members');
const DEFAULT = row('users-default', 'New members start as', 'Members');

function view(over: Partial<RoomPermissionsView> = {}): RoomPermissionsView {
  return {
    rows: [
      rowView(SEND, 0),
      rowView(INVITE, 25),
      rowView(BAN, 'mixed'),
      rowView(DEFAULT, 0),
    ],
    myPower: 100,
    editable: true,
    reason: null,
    powerFromDefault: false,
    permissionsLevel: 50,
    ...over,
  };
}

async function setup(
  initial: RoomPermissionsView = view(),
  saveResult = of(undefined) as ReturnType<RoomPermissionsService['save']>,
  confirmed = true,
) {
  const current = signal(initial);
  const save = vi.fn(() => saveResult);
  const confirm$ = vi.fn(() => of(confirmed));
  const result = await render(PermissionsSettingsComponent, {
    inputs: { accountId: '@me:hs', roomId: '!r:hs', kind: 'room' },
    providers: [
      MockProvider(RoomPermissionsService, { view: () => current(), save }),
      MockProvider(TrnAlertService, { confirm$ }),
    ],
  });
  return { ...result, current, save, confirm$ };
}

const tick = (): Promise<void> => TestBed.inject(ApplicationRef).whenStable();

async function choose(name: string, option: string): Promise<void> {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
  await tick();
}

describe('PermissionsSettingsComponent', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it('renders each group and row from the view', async () => {
    await setup();

    for (const heading of ['Messages', 'Members']) {
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(screen.getByTestId('permissions-row-send-messages')).toBeTruthy();
    expect(screen.getByTestId('permissions-row-invite')).toBeTruthy();
  });

  it('shows Custom (25) for a non-standard level and Mixed for a mixed row', async () => {
    await setup();

    expect(
      screen.getByRole('combobox', { name: 'Invite' }).textContent,
    ).toContain('Custom (25)');
    expect(screen.getByRole('combobox', { name: 'Ban' }).textContent).toContain(
      'Mixed',
    );
  });

  it('disables a row above my power with its reason', async () => {
    await setup(
      view({
        rows: [
          rowView(SEND, 0),
          rowView(BAN, 100, {
            editable: false,
            reason: 'Only someone with a higher role can change this',
          }),
        ],
      }),
    );

    expect(
      screen.getByRole('combobox', { name: 'Ban' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByTestId('permissions-row-ban').textContent).toContain(
      'Only someone with a higher role can change this',
    );
    expect(
      screen
        .getByRole('combobox', { name: 'Send messages' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('read-only view disables every row and shows the reason', async () => {
    await setup(
      view({
        editable: false,
        reason: "Your role cannot change this room's permissions.",
        rows: [
          rowView(SEND, 0, { editable: false, reason: 'x' }),
          rowView(BAN, 50, { editable: false, reason: 'x' }),
        ],
      }),
    );

    expect(screen.getByTestId('permissions-readonly').textContent).toContain(
      "Your role cannot change this room's permissions.",
    );
    for (const name of ['Send messages', 'Ban']) {
      expect(
        screen.getByRole('combobox', { name }).hasAttribute('disabled'),
      ).toBe(true);
    }
  });

  it('choosing Moderator makes it dirty; Discard clears it', async () => {
    const { fixture } = await setup();
    const component = fixture.componentInstance;
    expect(component.dirty()).toBe(false);

    await choose('Send messages', 'Moderator');
    expect(component.dirty()).toBe(true);
    expect(
      screen.getByRole('combobox', { name: 'Send messages' }).textContent,
    ).toContain('Moderator');

    fireEvent.click(screen.getByTestId('permissions-discard'));
    await tick();
    expect(component.dirty()).toBe(false);
    expect(screen.queryByTestId('permissions-save')).toBeNull();
  });

  it('Custom accepts a whole number up to my power', async () => {
    await setup();
    await choose('Send messages', 'Custom');
    const input = screen.getByTestId(
      'permissions-custom-send-messages',
    ) as HTMLInputElement;
    const save = screen.getByTestId('permissions-save') as HTMLButtonElement;

    fireEvent.input(input, { target: { value: '60' } });
    await tick();
    expect(save.disabled).toBe(false);
    expect(screen.queryByText('Enter a whole number up to 100.')).toBeNull();

    for (const bad of ['150', '1.5', '']) {
      fireEvent.input(input, { target: { value: bad } });
      await tick();
      expect(save.disabled).toBe(true);
      expect(screen.getByText('Enter a whole number up to 100.')).toBeTruthy();
    }
  });

  it('has no cap for an unlimited editor', async () => {
    await setup(view({ myPower: Infinity }));
    await choose('Send messages', 'Custom');
    fireEvent.input(screen.getByTestId('permissions-custom-send-messages'), {
      target: { value: 'x' },
    });
    await tick();

    expect(screen.getByText('Enter a whole number.')).toBeTruthy();
  });

  it('Save sends only changed rows', async () => {
    const { save } = await setup();
    await choose('Send messages', 'Moderator');

    fireEvent.click(screen.getByTestId('permissions-save'));
    await tick();

    expect(save).toHaveBeenCalledWith(
      { accountId: '@me:hs', roomId: '!r:hs' },
      'room',
      new Map([['send-messages', 50]]),
    );
  });

  it('a remote change updates unedited rows and keeps edited ones', async () => {
    const { current } = await setup();
    await choose('Send messages', 'Admin');

    current.set(
      view({
        rows: [
          rowView(SEND, 50),
          rowView(INVITE, 100),
          rowView(BAN, 'mixed'),
          rowView(DEFAULT, 0),
        ],
      }),
    );
    await tick();

    expect(
      screen.getByRole('combobox', { name: 'Invite' }).textContent,
    ).toContain('Admin');
    expect(
      screen.getByRole('combobox', { name: 'Send messages' }).textContent,
    ).toContain('Admin');
  });

  describe('self-lockout save', () => {
    const lockout = () =>
      view({
        powerFromDefault: true,
        permissionsLevel: 50,
        rows: [rowView(DEFAULT, 50)],
      });

    it('asks first and saves nothing when declined', async () => {
      const { save, confirm$ } = await setup(lockout(), undefined, false);
      await choose('New members start as', 'Member');

      fireEvent.click(screen.getByTestId('permissions-save'));
      await tick();

      expect(confirm$).toHaveBeenCalledWith(
        expect.objectContaining({
          header: 'Lose permission to edit permissions?',
          confirmText: 'Save anyway',
        }),
      );
      expect(save).not.toHaveBeenCalled();
    });

    it('saves once confirmed', async () => {
      const { save, confirm$ } = await setup(lockout());
      await choose('New members start as', 'Member');

      fireEvent.click(screen.getByTestId('permissions-save'));
      await tick();

      expect(confirm$).toHaveBeenCalled();
      expect(save).toHaveBeenCalledOnce();
    });
  });

  it('a failed save keeps the draft and shows the error', async () => {
    const { fixture } = await setup(
      view(),
      throwError(() => new Error('boom')),
    );
    await choose('Send messages', 'Moderator');

    fireEvent.click(screen.getByTestId('permissions-save'));
    await tick();

    expect(screen.getByTestId('permissions-error')).toBeTruthy();
    expect(fixture.componentInstance.dirty()).toBe(true);
  });

  it('each select is named by its row label', async () => {
    await setup();

    expect(
      screen.getByRole('combobox', { name: 'Send messages' }),
    ).toBeTruthy();
  });
});
