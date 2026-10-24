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
    serverName?: string | null;
    setListed?: (target: unknown, listed: boolean) => Observable<void>;
  } = {},
) {
  const snapshot = signal({
    target: TARGET,
  } as unknown as RoomSettingsSnapshot);
  const permissions = signal({
    directory: options.directory ?? ALLOWED,
    imagePack: ALLOWED,
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
  const text = (testId: string): string =>
    container.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ??
    '';
  const announced = (): string => text('room-settings-directory-announcer');
  return {
    fixture,
    container,
    toggle,
    flip,
    text,
    announced,
    listed,
    setListed,
    permissions,
  };
}

describe('RoomSettingsDirectoryComponent', () => {
  it("names the opening account's server and explains what listing does", async () => {
    const { toggle, container } = await build();

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
    expect(container.querySelector('label')?.getAttribute('for')).toBe(
      toggle()?.id,
    );
  });

  it('keeps one persistent, empty status region for announcements', async () => {
    const { container, announced } = await build();

    const regions = container.querySelectorAll(
      '[role="status"], [role="alert"]',
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('data-testid')).toBe(
      'room-settings-directory-announcer',
    );
    expect(announced()).toBe('');
  });

  it('shows the current listing for the opening account', async () => {
    const { toggle, listed } = await build({ listed: () => of(true) });

    expect(listed).toHaveBeenCalledWith(TARGET);
    expect(toggle()?.checked).toBe(true);
  });

  it('says it is checking until the server answers, with no label pointing nowhere', async () => {
    const answer = new Subject<boolean>();
    const { fixture, toggle, text, container } = await build({
      listed: () => answer,
    });

    expect(text('room-settings-directory-checking')).toBe('Checking…');
    expect(toggle()).toBeNull();
    expect(container.querySelector('label[for]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    answer.next(true);
    answer.complete();
    fixture.detectChanges();

    expect(toggle()?.checked).toBe(true);
  });

  it('offers Try again when the listing could not be read, and announces it', async () => {
    let fail = true;
    const { fixture, toggle, listed, text, announced } = await build({
      listed: () => (fail ? throwError(() => new Error('offline')) : of(true)),
    });

    expect(text('room-settings-directory-load-failed')).toBe(
      "Couldn't check whether this room is listed.",
    );
    expect(announced()).toBe("Couldn't check whether this room is listed.");
    expect(toggle()).toBeNull();

    fail = false;
    screen.getByRole('button', { name: 'Try again' }).click();
    fixture.detectChanges();

    expect(listed).toHaveBeenCalledTimes(2);
    expect(toggle()?.checked).toBe(true);
    expect(text('room-settings-directory-load-failed')).toBe('');
  });

  it('disables the switch with the reason when the role may not change it', async () => {
    const { toggle } = await build({ directory: NO_ROLE });

    expect(toggle()?.disabled).toBe(true);
    const reason = screen.getByText(NO_ROLE.reason as string);
    expect(toggle()?.getAttribute('aria-describedby')).toContain(reason.id);
  });

  it('points at no reason when a denial gives none', async () => {
    const { toggle } = await build({
      directory: { available: false, reason: null },
    });

    expect(toggle()?.getAttribute('aria-describedby')).toBe(
      'room-settings-directory-switch-description',
    );
  });

  it('lists the room at once, keeps the new value and announces it', async () => {
    const { flip, toggle, setListed, announced } = await build();

    flip();

    expect(setListed).toHaveBeenCalledExactlyOnceWith(TARGET, true);
    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.getAttribute('aria-disabled')).toBeNull();
    expect(announced()).toBe("Listed in hs.example's room directory.");
  });

  it('announces an unlisting too', async () => {
    const { flip, announced } = await build({ listed: () => of(true) });

    flip();

    expect(announced()).toBe("Not listed in hs.example's room directory.");
  });

  it('keeps the busy switch focusable and ignores presses until the server answers', async () => {
    const pending = new Subject<void>();
    const { fixture, flip, toggle, setListed } = await build({
      setListed: () => pending,
    });
    toggle()?.focus();

    flip();
    const busy = toggle();
    expect(busy?.checked).toBe(true);
    expect(busy?.disabled).toBe(false);
    expect(busy?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(busy);

    flip();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(setListed).toHaveBeenCalledTimes(1);
    expect(toggle()?.checked).toBe(true);
    expect(document.activeElement).toBe(busy);
  });

  it("reverts and explains a server that doesn't let this account list rooms", async () => {
    const { flip, toggle, text, announced, listed } = await build({
      setListed: () =>
        throwError(() =>
          setOutcome(
            'permission-denied',
            "Your server doesn't let you list rooms in its directory.",
            new MatrixError({ errcode: 'M_FORBIDDEN', error: 'nope' }, 403),
          ),
        ),
    });
    toggle()?.focus();

    flip();

    const message = "Your server doesn't let you list rooms in its directory.";
    expect(text('room-settings-directory-error')).toBe(message);
    expect(announced()).toBe(`Not listed. ${message}`);
    expect(toggle()?.checked).toBe(false);
    expect(document.activeElement).toBe(toggle());
    expect(toggle()?.getAttribute('aria-describedby')).toContain(
      'room-settings-directory-switch-error',
    );
    expect(listed).toHaveBeenCalledTimes(1);
  });

  it('re-reads the listing after any other failure instead of guessing', async () => {
    const reread = new Subject<boolean>();
    let reads = 0;
    const { fixture, flip, toggle, text, announced, container } = await build({
      listed: () => (reads++ === 0 ? of(false) : reread),
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
    toggle()?.focus();

    flip();

    const message = 'The homeserver is unavailable. Try again.';
    expect(text('room-settings-directory-error')).toBe(message);
    expect(announced()).toBe(message);
    expect(reads).toBe(2);
    expect(toggle()?.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).not.toContain('upstream body');

    reread.next(true);
    reread.complete();
    fixture.detectChanges();

    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});
