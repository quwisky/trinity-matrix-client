import { signal } from '@angular/core';
import { render, screen } from '@trinity/testing';
import {
  TrnAlertService,
  type ConfirmOptions,
} from '@trinity/components/overlay';
import {
  JoinRule,
  RoomAdministrationError,
  RoomEncryptionService,
  type ActionAvailability,
  type RoomSettingsSnapshot,
} from '@trinity/data-access/room-administration';
import { MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { RoomSettingsEncryptionComponent } from './room-settings-encryption.component';

const TARGET = { accountId: '@opening:hs', roomId: '!room:hs' } as const;
const ALLOWED: ActionAvailability = { available: true, reason: null };
const NO_PERMISSION: ActionAvailability = {
  available: false,
  reason: 'Only people who can change room settings can turn on encryption.',
};

interface State {
  readonly encrypted: boolean | null;
  readonly joinRule?: JoinRule;
  readonly encryption?: ActionAvailability;
}

function snapshot({
  encrypted,
  joinRule = JoinRule.Invite,
  encryption = ALLOWED,
}: State): RoomSettingsSnapshot {
  return {
    target: TARGET,
    encrypted,
    access: { joinRule },
    permissions: { encryption },
  } as unknown as RoomSettingsSnapshot;
}

async function build(
  initial: State,
  options: {
    confirmed?: boolean;
    turnOn?: () => Observable<void>;
  } = {},
) {
  const state = signal(snapshot(initial));
  const confirm = vi.fn((_options: ConfirmOptions) =>
    of(options.confirmed ?? true),
  );
  const turnOn = vi.fn(options.turnOn ?? (() => of(undefined)));
  const { fixture, container } = await render(RoomSettingsEncryptionComponent, {
    providers: [
      MockProvider(RoomSettingsDraftService, {
        snapshot: state.asReadonly(),
      }),
      MockProvider(TrnAlertService, { confirm$: confirm }),
      MockProvider(RoomEncryptionService, { turnOn }),
    ],
  });
  const update = (next: State): void => {
    state.set(snapshot(next));
    fixture.detectChanges();
  };
  const status = (): string =>
    container
      .querySelector('[data-testid="room-settings-encryption"]')
      ?.textContent?.trim()
      .replace(/\s+/g, ' ') ?? '';
  const button = (): HTMLButtonElement | null =>
    container.querySelector('[data-testid="room-settings-encryption-on"]');
  return { fixture, container, update, status, button, confirm, turnOn };
}

describe('RoomSettingsEncryptionComponent', () => {
  it('says an encrypted room stays encrypted and offers nothing to change', async () => {
    const { status, button } = await build({ encrypted: true });

    expect(status()).toBe(
      "Messages in this room are end-to-end encrypted. This can't be turned off.",
    );
    expect(button()).toBeNull();
  });

  it('offers nothing while the status is unknown', async () => {
    const { status, button } = await build({ encrypted: null });

    expect(status()).toBe('Encryption status is unavailable.');
    expect(button()).toBeNull();
  });

  it('offers Turn on encryption in an unencrypted room the role may change', async () => {
    const { status, button } = await build({ encrypted: false });

    expect(status()).toBe(
      'Messages in this room are not end-to-end encrypted.',
    );
    expect(button()?.textContent?.trim()).toBe('Turn on encryption…');
    expect(button()?.type).toBe('button');
  });

  it('explains who may turn it on instead of offering the button', async () => {
    const { button } = await build({
      encrypted: false,
      encryption: NO_PERMISSION,
    });

    expect(button()).toBeNull();
    expect(
      screen.getByText(
        'Only people who can change room settings can turn on encryption.',
      ),
    ).toBeTruthy();
  });

  it('warns that it is one-way and sends nothing when cancelled', async () => {
    const { button, confirm, turnOn } = await build(
      { encrypted: false },
      { confirmed: false },
    );

    button()?.click();

    expect(confirm).toHaveBeenCalledExactlyOnceWith({
      header: 'Turn on encryption?',
      message:
        "This can't be undone. New messages will be end-to-end encrypted; earlier messages stay as they are. Bridges, bots and some older apps may stop working here.",
      confirmText: 'Turn on encryption',
      variant: 'danger',
    });
    expect(turnOn).not.toHaveBeenCalled();
  });

  it('adds the public-room caveat when anyone can join', async () => {
    const { button, confirm } = await build(
      { encrypted: false, joinRule: JoinRule.Public },
      { confirmed: false },
    );

    button()?.click();

    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(
        /\n\nAnyone can join this room, so encryption adds little privacy and can make joining slower\.$/,
      ),
    });
  });

  it('turns it on for the opening account and waits for sync to change the status', async () => {
    const { fixture, button, status, turnOn, update } = await build({
      encrypted: false,
    });

    button()?.click();
    fixture.detectChanges();

    expect(turnOn).toHaveBeenCalledExactlyOnceWith(TARGET);
    expect(status()).toBe(
      'Messages in this room are not end-to-end encrypted.',
    );
    expect(button()).toBeNull();
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      'Turning on encryption…',
    );

    update({ encrypted: true });

    expect(status()).toBe(
      "Messages in this room are end-to-end encrypted. This can't be turned off.",
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the button disabled while the request is in flight', async () => {
    const pending = new Subject<void>();
    const { fixture, button, turnOn } = await build(
      { encrypted: false },
      { turnOn: () => pending },
    );

    button()?.click();
    fixture.detectChanges();
    button()?.click();

    expect(button()?.disabled).toBe(true);
    expect(turnOn).toHaveBeenCalledTimes(1);
  });

  it('shows a plain failure next to the button and lets the user try again', async () => {
    let fail = true;
    const { fixture, button, turnOn, container } = await build(
      { encrypted: false },
      {
        turnOn: () =>
          fail
            ? throwError(
                () =>
                  new RoomAdministrationError(
                    {
                      kind: 'rejected',
                      failure: 'server-rejected',
                      recovery: 'retry-operation',
                      operation: 'turn-on-encryption',
                    },
                    'MatrixError: [500] upstream with a body',
                    new MatrixError(
                      { errcode: 'M_UNKNOWN', error: 'upstream with a body' },
                      500,
                    ),
                  ),
              )
            : of(undefined),
      },
    );

    button()?.click();
    fixture.detectChanges();

    const alert = screen.getByRole('alert');
    expect(alert.textContent?.trim()).toBe(
      'The homeserver is unavailable. Try again.',
    );
    expect(button()?.getAttribute('aria-describedby')).toBe(alert.id);
    expect(container.textContent).not.toContain('with a body');

    fail = false;
    button()?.click();
    fixture.detectChanges();

    expect(turnOn).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
