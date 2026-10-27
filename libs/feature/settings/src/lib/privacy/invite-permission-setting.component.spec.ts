import { signal } from '@angular/core';
import { InvitePermissionService } from '@trinity/data-access/room-library';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { InvitePermissionSettingComponent } from './invite-permission-setting.component';

async function setup(
  opts: {
    supported?: boolean | null;
    blocked?: boolean;
    setBlocked?: Mock<(blocked: boolean) => Observable<void>>;
    accounts?: readonly string[];
  } = {},
) {
  const supported = signal<boolean | null>(
    'supported' in opts ? (opts.supported ?? null) : true,
  );
  const blocked = signal(opts.blocked ?? false);
  const projection = new Subject<void>();
  const setBlocked =
    opts.setBlocked ??
    vi.fn((next: boolean): Observable<void> => {
      blocked.set(next);
      return of(undefined);
    });
  const view = await render(InvitePermissionSettingComponent, {
    providers: [
      MockProvider(InvitePermissionService, {
        supported: supported.asReadonly(),
        blocked: blocked.asReadonly(),
        runProjection: () => projection,
        setBlocked,
      }),
      MockProvider(SessionStateService, {
        activeAccountId: signal<string | null>('@me:hs').asReadonly(),
        accountIds: signal<readonly string[]>(
          opts.accounts ?? ['@me:hs'],
        ).asReadonly(),
      }),
    ],
  });
  return { ...view, supported, blocked, projection, setBlocked };
}

describe('InvitePermissionSettingComponent', () => {
  it('holds the invite permission projection while shown', async () => {
    const { projection } = await setup();

    expect(projection.observed).toBe(true);
  });

  it.each([false, null])(
    'renders nothing while support is %s',
    async (supported) => {
      const { container } = await setup({ supported });

      expect(
        container.querySelector('[data-testid=privacy-invites]'),
      ).toBeNull();
    },
  );

  it('offers who can invite you, with the current server setting chosen', async () => {
    await setup({ blocked: false });

    const group = screen.getByRole('radiogroup', {
      name: 'Who can invite you',
    });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /Allow all invites/ }),
    ).toBeChecked();
    const block = screen.getByRole('radio', { name: /Block all invites/ });
    expect(block).not.toBeChecked();
    expect(block.closest('label')?.textContent).toContain(
      'Your server turns down every invite. People who invite you see an error, and invites you already have are hidden.',
    );
  });

  it('saves a change as soon as it is chosen', async () => {
    const { fixture, setBlocked } = await setup({ blocked: false });

    screen.getByRole('radio', { name: /Block all invites/ }).click();
    fixture.detectChanges();

    expect(setBlocked).toHaveBeenCalledExactlyOnceWith(true);
    expect(
      screen.getByRole('radio', { name: /Block all invites/ }),
    ).toBeChecked();
  });

  it('reverts and explains when the change fails', async () => {
    const write = new Subject<void>();
    const { fixture } = await setup({
      blocked: false,
      setBlocked: vi.fn((): Observable<void> => write),
    });

    screen.getByRole('radio', { name: /Block all invites/ }).click();
    fixture.detectChanges();
    write.error(new Error('offline'));
    fixture.detectChanges();

    expect(
      screen.getByRole('radio', { name: /Allow all invites/ }),
    ).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't change this. Try again.",
    );
  });

  it('hands every choice to the service at once, so closing Settings loses none', async () => {
    const writes: Subject<void>[] = [];
    const setBlocked = vi.fn((): Observable<void> => {
      const write = new Subject<void>();
      writes.push(write);
      return write;
    });
    const { fixture } = await setup({ blocked: false, setBlocked });

    screen.getByRole('radio', { name: /Block all invites/ }).click();
    fixture.detectChanges();
    screen.getByRole('radio', { name: /Allow all invites/ }).click();
    fixture.detectChanges();
    fixture.destroy();

    expect(setBlocked.mock.calls).toEqual([[true], [false]]);
  });

  it('shows the newest choice until every write has settled', async () => {
    const writes: Subject<void>[] = [];
    const setBlocked = vi.fn((): Observable<void> => {
      const write = new Subject<void>();
      writes.push(write);
      return write;
    });
    const { fixture } = await setup({ blocked: false, setBlocked });

    screen.getByRole('radio', { name: /Block all invites/ }).click();
    fixture.detectChanges();
    screen.getByRole('radio', { name: /Allow all invites/ }).click();
    fixture.detectChanges();
    writes[0].complete();
    fixture.detectChanges();

    expect(
      screen.getByRole('radio', { name: /Allow all invites/ }),
    ).toBeChecked();
  });

  it('names the account it applies to when several are signed in', async () => {
    const { container } = await setup({ accounts: ['@me:hs', '@work:hs'] });

    expect(
      container.querySelector('[data-testid=privacy-invites]')?.textContent,
    ).toContain('Invites to @me:hs.');
  });

  it('does not name the account when only one is signed in', async () => {
    const { container } = await setup();

    expect(
      container.querySelector('[data-testid=privacy-invites]')?.textContent,
    ).not.toContain('@me:hs');
  });
});
