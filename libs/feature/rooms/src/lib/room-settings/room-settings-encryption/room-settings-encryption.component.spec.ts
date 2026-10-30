import { signal } from '@angular/core';
import { render, screen, matrixError } from '@trinity/testing';
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
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { RoomSettingsEncryptionComponent } from './room-settings-encryption.component';

const TARGET = { accountId: '@opening:hs', roomId: '!room:hs' } as const;
const ALLOWED: ActionAvailability = { available: true, reason: null };
const NO_PERMISSION: ActionAvailability = {
  available: false,
  reason: 'Only people who can change room settings can turn on encryption.',
};
const LATE_STATUS =
  'Encryption is on for this room, but not yet on this device.';
const LATE =
  "This device couldn't apply it, so messages you send from here may not be encrypted.";

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
    confirm?: (options: ConfirmOptions) => Observable<boolean>;
    confirmed?: boolean;
    turnOn?: () => Observable<void>;
  } = {},
) {
  const state = signal(snapshot(initial));
  const confirm = vi.fn(
    options.confirm ??
      ((_options: ConfirmOptions) => of(options.confirmed ?? true)),
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
  const text = (testId: string): string =>
    container
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent?.trim()
      .replace(/\s+/g, ' ') ?? '';
  const status = (): string => text('room-settings-encryption');
  const announced = (): string => text('room-settings-encryption-announcer');
  const button = (): HTMLButtonElement | null =>
    container.querySelector('[data-testid="room-settings-encryption-on"]');
  /** Click as a user would; the dialog then returns focus to the button. */
  const press = (): void => {
    const target = button();
    if (!target) throw new Error('No button');
    target.focus();
    target.click();
    fixture.detectChanges();
  };
  return {
    fixture,
    container,
    update,
    status,
    announced,
    text,
    button,
    press,
    confirm,
    turnOn,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

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
    const { status, button, announced, container } = await build({
      encrypted: false,
    });

    expect(status()).toBe(
      'Messages in this room are not end-to-end encrypted.',
    );
    expect(button()?.textContent?.trim()).toBe('Turn on encryption…');
    expect(button()?.type).toBe('button');
    expect(button()?.getAttribute('aria-disabled')).toBeNull();
    const announcer = container.querySelector(
      '[data-testid="room-settings-encryption-announcer"]',
    );
    expect(announcer?.getAttribute('role')).toBe('status');
    expect(announced()).toBe('');
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
    const { press, confirm, turnOn } = await build(
      { encrypted: false },
      { confirmed: false },
    );

    press();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      header: 'Turn on encryption?',
      message:
        "This can't be undone. New messages will be end-to-end encrypted; earlier messages stay as they are. Bridges, bots and some older apps may stop working here.",
      confirmText: 'Turn on encryption',
      variant: 'danger',
    });
    expect(turnOn).not.toHaveBeenCalled();
  });

  it('adds the public-room caveat when anyone can join', async () => {
    const { press, confirm } = await build(
      { encrypted: false, joinRule: JoinRule.Public },
      { confirmed: false },
    );

    press();

    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(
        /\n\nAnyone can join this room, so encryption adds little privacy and can make joining slower\.$/,
      ),
    });
  });

  it('closes the confirmation when the room is encrypted from elsewhere meanwhile', async () => {
    const answer = new Subject<boolean>();
    const { press, confirm, update } = await build(
      { encrypted: false },
      { confirm: () => answer },
    );
    press();
    const withdrawn = vi.fn();
    confirm.mock.calls[0]?.[0].closeWhen?.subscribe(withdrawn);

    update({ encrypted: false });
    expect(withdrawn).not.toHaveBeenCalled();

    update({ encrypted: true });
    expect(withdrawn).toHaveBeenCalled();
  });

  it('keeps the focused button in place, busy, until this device has applied it', async () => {
    const pending = new Subject<void>();
    const { fixture, button, press, status, announced, turnOn } = await build(
      { encrypted: false },
      { turnOn: () => pending },
    );

    press();
    const busy = button();
    expect(turnOn).toHaveBeenCalledExactlyOnceWith(TARGET);
    expect(busy?.textContent?.trim()).toBe('Turning on encryption…');
    expect(busy?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(busy);
    expect(announced()).toBe('Turning on encryption…');

    pending.complete();
    fixture.detectChanges();

    expect(button()).toBeNull();
    expect(status()).toBe(
      "Messages in this room are end-to-end encrypted. This can't be turned off.",
    );
    expect(announced()).toBe('Encryption is on.');
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'room-settings-encryption',
    );
  });

  it('shows it on when sync delivers it before the request settles', async () => {
    const pending = new Subject<void>();
    const { button, press, announced, update } = await build(
      { encrypted: false },
      { turnOn: () => pending },
    );

    press();
    update({ encrypted: true });

    expect(button()).toBeNull();
    expect(announced()).toBe('Encryption is on.');
  });

  it('ignores presses while busy', async () => {
    const pending = new Subject<void>();
    const { press, confirm, turnOn } = await build(
      { encrypted: false },
      { turnOn: () => pending },
    );

    press();
    press();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(turnOn).toHaveBeenCalledTimes(1);
  });

  it('lets only one of two open confirmations start a request', async () => {
    const answers = [new Subject<boolean>(), new Subject<boolean>()];
    const pending = new Subject<void>();
    let opened = 0;
    const { fixture, button, turnOn } = await build(
      { encrypted: false },
      {
        confirm: () => answers[opened++] as Subject<boolean>,
        turnOn: () => pending,
      },
    );

    button()?.click();
    button()?.click();
    answers[0]?.next(true);
    answers[0]?.complete();
    answers[1]?.next(true);
    answers[1]?.complete();
    fixture.detectChanges();

    expect(turnOn).toHaveBeenCalledTimes(1);
    expect(button()?.getAttribute('aria-disabled')).toBe('true');
  });

  it('warns that this device may still send unencrypted when it could not apply it, and retries without asking again', async () => {
    let failures = 1;
    const notApplied = () =>
      new RoomAdministrationError(
        {
          kind: 'rejected',
          failure: 'partial-update',
          recovery: 'review-room-state',
          operation: 'turn-on-encryption',
        },
        "Encryption is on, but this device couldn't apply it.",
      );
    const { button, press, text, status, announced, confirm, turnOn } =
      await build(
        { encrypted: false },
        {
          turnOn: () =>
            failures-- > 0 ? throwError(notApplied) : of(undefined),
        },
      );

    press();

    expect(status()).toBe(LATE_STATUS);
    expect(text('room-settings-encryption-late')).toBe(LATE);
    expect(announced()).toBe(`${LATE_STATUS} ${LATE}`);
    expect(text('room-settings-encryption-error')).toBe('');
    expect(button()?.textContent?.trim()).toBe('Try again on this device');
    expect(button()?.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(button());

    press();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(turnOn).toHaveBeenCalledTimes(2);
    expect(text('room-settings-encryption-late')).toBe('');
    expect(button()).toBeNull();
    expect(status()).toBe(
      "Messages in this room are end-to-end encrypted. This can't be turned off.",
    );
    expect(announced()).toBe('Encryption is on.');
  });

  it('stays in the warning with a plain failure when a retry fails otherwise', async () => {
    let calls = 0;
    const { press, text, status, button } = await build(
      { encrypted: false },
      {
        turnOn: () =>
          throwError(() =>
            ++calls === 1
              ? new RoomAdministrationError(
                  {
                    kind: 'rejected',
                    failure: 'partial-update',
                    recovery: 'review-room-state',
                    operation: 'turn-on-encryption',
                  },
                  'not applied',
                )
              : new Error('offline'),
          ),
      },
    );

    press();
    press();

    expect(status()).toBe(LATE_STATUS);
    expect(text('room-settings-encryption-late')).toBe(LATE);
    expect(text('room-settings-encryption-error')).toBe(
      "Couldn't turn on encryption. Try again.",
    );
    expect(button()?.textContent?.trim()).toBe('Try again on this device');
  });

  it('ends the warning when sync later delivers the event', async () => {
    const { press, text, announced, update } = await build(
      { encrypted: false },
      {
        turnOn: () =>
          throwError(
            () =>
              new RoomAdministrationError(
                {
                  kind: 'rejected',
                  failure: 'partial-update',
                  recovery: 'review-room-state',
                  operation: 'turn-on-encryption',
                },
                'not applied',
              ),
          ),
      },
    );

    press();
    update({ encrypted: true });

    expect(text('room-settings-encryption-late')).toBe('');
    expect(announced()).toBe('Encryption is on.');
  });

  it('shows no warning once this device has applied it, however long sync takes', async () => {
    vi.useFakeTimers();
    const { fixture, press, text, status } = await build({ encrypted: false });

    press();
    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();

    expect(text('room-settings-encryption-late')).toBe('');
    expect(status()).toBe(
      "Messages in this room are end-to-end encrypted. This can't be turned off.",
    );
  });

  it('shows a plain failure next to the button and lets the user try again', async () => {
    let fail = true;
    const { button, press, turnOn, text, announced, container } = await build(
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
                    matrixError('M_UNKNOWN', 500, {
                      error: 'upstream with a body',
                    }),
                  ),
              )
            : of(undefined),
      },
    );

    press();

    const message = 'The homeserver is unavailable. Try again.';
    expect(text('room-settings-encryption-error')).toBe(message);
    expect(announced()).toBe(message);
    const error = container.querySelector(
      '[data-testid="room-settings-encryption-error"]',
    );
    expect(button()?.getAttribute('aria-describedby')).toBe(error?.id);
    expect(button()?.getAttribute('aria-disabled')).toBeNull();
    expect(container.textContent).not.toContain('with a body');

    fail = false;
    press();

    expect(turnOn).toHaveBeenCalledTimes(2);
    expect(text('room-settings-encryption-error')).toBe('');
  });
});
