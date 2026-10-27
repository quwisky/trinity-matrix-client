import { signal } from '@angular/core';
import { TrnToastService } from '@trinity/components/overlay';
import { AvatarComponent } from '@trinity/components/generic-content';
import {
  IgnoredUsersService,
  type IgnoredUser,
} from '@trinity/data-access/identity';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { render, screen } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { BlockedUsersComponent } from './blocked-users.component';

const BOB: IgnoredUser = {
  userId: '@bob:hs',
  displayName: 'Bob',
  avatarMxc: 'mxc://hs/bob',
};
function type(field: HTMLElement, value: string): void {
  (field as HTMLInputElement).value = value;
  field.dispatchEvent(new Event('input'));
}

const EVE: IgnoredUser = {
  userId: '@eve:hs',
  displayName: null,
  avatarMxc: null,
};

async function setup(
  opts: {
    users?: readonly IgnoredUser[];
    accounts?: readonly string[];
    ignore?: Mock<(userId: string) => Observable<void>>;
    unignore?: Mock<(userId: string) => Observable<void>>;
  } = {},
) {
  const users = signal<readonly IgnoredUser[]>(opts.users ?? []);
  const projection = new Subject<void>();
  const ignore = opts.ignore ?? vi.fn((): Observable<void> => of(undefined));
  const unignore =
    opts.unignore ?? vi.fn((): Observable<void> => of(undefined));
  const show = vi.fn();
  const view = await render(BlockedUsersComponent, {
    imports: [MockComponent(AvatarComponent)],
    providers: [
      MockProvider(IgnoredUsersService, {
        ignoredUsers: users.asReadonly(),
        runProjection: () => projection,
        ignore,
        unignore,
      }),
      MockProvider(SessionStateService, {
        activeAccountId: signal<string | null>('@me:hs').asReadonly(),
        accountIds: signal<readonly string[]>(
          opts.accounts ?? ['@me:hs'],
        ).asReadonly(),
      }),
      MockProvider(TrnToastService, { show }),
    ],
  });
  return { ...view, users, projection, ignore, unignore, show };
}

describe('BlockedUsersComponent', () => {
  it('holds the ignore list projection while shown', async () => {
    const { projection } = await setup();

    expect(projection.observed).toBe(true);
  });

  it('says when nobody is blocked', async () => {
    await setup();

    expect(screen.getByText("You haven't blocked anyone.")).toBeVisible();
  });

  it('lists each blocked user by name and user ID, or the bare ID when unknown', async () => {
    const { container } = await setup({ users: [BOB, EVE] });

    const rows = container.querySelectorAll('[data-testid=blocked-user-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Bob');
    expect(rows[0].textContent).toContain('@bob:hs');
    expect(rows[1].textContent?.trim()).toContain('@eve:hs');
    expect(
      screen.getByRole('button', { name: 'Unblock Bob' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Unblock @eve:hs' }),
    ).toBeInTheDocument();
  });

  it('unblocks a user and confirms', async () => {
    const { unignore, show } = await setup({ users: [BOB] });

    screen.getByRole('button', { name: 'Unblock Bob' }).click();

    expect(unignore).toHaveBeenCalledExactlyOnceWith('@bob:hs');
    expect(show).toHaveBeenCalledWith('Unblocked Bob.', expect.anything());
  });

  it('explains a failed unblock', async () => {
    const { show } = await setup({
      users: [BOB],
      unignore: vi.fn((): Observable<void> =>
        throwError(() => new Error('offline')),
      ),
    });

    screen.getByRole('button', { name: 'Unblock Bob' }).click();

    expect(show).toHaveBeenCalledWith(
      "Couldn't unblock Bob. Try again.",
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('blocks someone by user ID and clears the field', async () => {
    const { fixture, ignore } = await setup();
    const field = screen.getByLabelText('Block someone by user ID');

    type(field, '  @mallory:example.org ');
    screen.getByRole('button', { name: 'Block' }).click();
    await fixture.whenStable();

    expect(ignore).toHaveBeenCalledExactlyOnceWith('@mallory:example.org');
    expect(field).toHaveValue('');
  });

  it.each([
    ['mallory', 'Enter a full user ID, such as @name:example.org.'],
    ['@me:hs', "You can't block yourself."],
    ['@bob:hs', "You've already blocked @bob:hs."],
  ])(
    'refuses %s and announces why next to the field',
    async (typed, message) => {
      const { fixture, ignore } = await setup({ users: [BOB] });
      const field = screen.getByLabelText('Block someone by user ID');

      type(field, typed);
      screen.getByRole('button', { name: 'Block' }).click();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(ignore).not.toHaveBeenCalled();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(message);
      expect(field).toHaveAccessibleDescription(message);
      expect(field).toHaveAttribute('aria-invalid', 'true');
    },
  );

  it('names the active account when several are signed in', async () => {
    const { container } = await setup({ accounts: ['@me:hs', '@work:hs'] });

    expect(container.textContent).toContain(
      "Blocks on @me:hs: you won't see messages or invites from these people.",
    );
  });

  it('does not name the account when only one is signed in', async () => {
    const { container } = await setup();

    expect(container.textContent).toContain(
      "You won't see messages or invites from people you block.",
    );
  });
});
