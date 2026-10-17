import { signal } from '@angular/core';
import { render, screen } from '@trinity/testing';
import {
  RoomAdministrationError,
  RoomDirectoryService,
  type ActionAvailability,
  type RoomSettingsPermissions,
  type RoomSettingsSnapshot,
} from '@trinity/data-access/room-administration';
import { MatrixError } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { RoomSettingsDirectoryComponent } from './room-settings-directory.component';

const TARGET = {
  accountId: '@opening:hs.example',
  roomId: '!room:hs',
} as const;
const ALLOWED: ActionAvailability = { available: true, reason: null };
const NO_ROLE: ActionAvailability = {
  available: false,
  reason: "Your role cannot change this room's directory listing.",
};

function setOutcome(
  failure: 'permission-denied' | 'server-rejected',
  message: string,
  cause: unknown,
) {
  return new RoomAdministrationError(
    {
      kind: 'rejected',
      failure,
      recovery:
        failure === 'permission-denied'
          ? 'refresh-authority'
          : 'retry-operation',
      operation: 'set-directory-visibility',
    },
    message,
    cause,
  );
}

async function build(
  options: {
    directory?: ActionAvailability;
    listed?: () => Observable<boolean>;
    setListed?: (target: unknown, listed: boolean) => Observable<void>;
  } = {},
) {
  const snapshot = signal({
    target: TARGET,
  } as unknown as RoomSettingsSnapshot);
  const permissions = signal({
    directory: options.directory ?? ALLOWED,
  } as RoomSettingsPermissions);
  const listed = vi.fn(options.listed ?? (() => of(false)));
  const setListed = vi.fn(options.setListed ?? (() => of(undefined)));
  const { fixture, container } = await render(RoomSettingsDirectoryComponent, {
    providers: [
      MockProvider(RoomSettingsDraftService, {
        snapshot: snapshot.asReadonly(),
        permissions: permissions.asReadonly(),
        targetAvailable: signal(true).asReadonly(),
      }),
      MockProvider(RoomDirectoryService, {
        serverName: () => 'hs.example',
        listed,
        setListed,
      }),
    ],
  });
  const toggle = (): HTMLInputElement | null =>
    container.querySelector('input[role="switch"]');
  const flip = (): void => {
    const input = toggle();
    if (!input) throw new Error('No switch');
    input.click();
    fixture.detectChanges();
  };
  return { fixture, container, toggle, flip, listed, setListed, permissions };
}

describe('RoomSettingsDirectoryComponent', () => {
  it("names the opening account's server and explains what listing does", async () => {
    const { toggle } = await build();

    expect(
      screen.getByText("List in hs.example's room directory"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'People on hs.example can find this room by searching. They still need to meet the joining rule to get in.',
      ),
    ).toBeTruthy();
    expect(toggle()?.checked).toBe(false);
    expect(toggle()?.disabled).toBe(false);
  });

  it('shows the current listing for the opening account', async () => {
    const { toggle, listed } = await build({ listed: () => of(true) });

    expect(listed).toHaveBeenCalledWith(TARGET);
    expect(toggle()?.checked).toBe(true);
  });

  it('says it is checking until the server answers', async () => {
    const answer = new Subject<boolean>();
    const { fixture, toggle } = await build({ listed: () => answer });

    expect(screen.getByRole('status').textContent?.trim()).toBe('Checking…');
    expect(toggle()).toBeNull();

    answer.next(true);
    answer.complete();
    fixture.detectChanges();

    expect(toggle()?.checked).toBe(true);
  });

  it('offers Try again when the listing could not be read', async () => {
    let fail = true;
    const { fixture, toggle, listed } = await build({
      listed: () => (fail ? throwError(() => new Error('offline')) : of(true)),
    });

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      "Couldn't check whether this room is listed.",
    );
    expect(toggle()).toBeNull();

    fail = false;
    screen.getByRole('button', { name: 'Try again' }).click();
    fixture.detectChanges();

    expect(listed).toHaveBeenCalledTimes(2);
    expect(toggle()?.checked).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables the switch with the reason when the role may not change it', async () => {
    const { toggle } = await build({ directory: NO_ROLE });

    expect(toggle()?.disabled).toBe(true);
    const reason = screen.getByText(NO_ROLE.reason as string);
    expect(toggle()?.getAttribute('aria-describedby')).toContain(reason.id);
  });

  it('lists the room at once and keeps the new value', async () => {
    const { flip, toggle, setListed } = await build();

    flip();

    expect(setListed).toHaveBeenCalledExactlyOnceWith(TARGET, true);
    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.disabled).toBe(false);
  });

  it('disables the switch while the change is in flight', async () => {
    const pending = new Subject<void>();
    const { flip, toggle, setListed } = await build({
      setListed: () => pending,
    });

    flip();

    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.disabled).toBe(true);
    expect(setListed).toHaveBeenCalledTimes(1);
  });

  it("reverts and explains a server that doesn't let this account list rooms", async () => {
    const { flip, toggle } = await build({
      setListed: () =>
        throwError(() =>
          setOutcome(
            'permission-denied',
            "Your server doesn't let you list rooms in its directory.",
            new MatrixError({ errcode: 'M_FORBIDDEN', error: 'nope' }, 403),
          ),
        ),
    });

    flip();

    const alert = screen.getByRole('alert');
    expect(alert.textContent?.trim()).toBe(
      "Your server doesn't let you list rooms in its directory.",
    );
    expect(toggle()?.checked).toBe(false);
    expect(toggle()?.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('reverts any other failure with plain words', async () => {
    const { flip, toggle, container } = await build({
      listed: () => of(true),
      setListed: () =>
        throwError(() =>
          setOutcome(
            'server-rejected',
            'MatrixError: [500] upstream body',
            new MatrixError(
              { errcode: 'M_UNKNOWN', error: 'upstream body' },
              500,
            ),
          ),
        ),
    });

    flip();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'The homeserver is unavailable. Try again.',
    );
    expect(toggle()?.checked).toBe(true);
    expect(container.textContent).not.toContain('upstream body');
  });
});
