import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  TrnAlertService,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import {
  IdentityServerService,
  type IdentityServerChoice,
} from '@trinity/data-access/contact-addresses';
import { fireEvent, render, screen } from '@trinity/testing';
import { ChangeIdentityServerDialogComponent } from './change-identity-server-dialog.component';
import { IdentityServerRowComponent } from './identity-server-row.component';

const ALICE = '@alice:example.org';
const SET: IdentityServerChoice = {
  kind: 'set',
  url: 'https://vector.im',
  source: 'account',
};

async function setup(
  choice: IdentityServerChoice,
  published: readonly string[] = [],
  disabled = false,
) {
  const closed = new Subject<unknown>();
  const confirmed = new Subject<boolean>();
  const calls: string[] = [];
  const identity = {
    unpublishAll: vi.fn((): Observable<unknown> => {
      calls.push('unpublishAll');
      return of({ kind: 'unpublished' } as const);
    }),
    turnOff: vi.fn(() => {
      calls.push('turnOff');
      return of({ kind: 'saved' } as const);
    }),
  };
  const changed = vi.fn();
  const rendered = await render(IdentityServerRowComponent, {
    inputs: { accountId: ALICE, choice, published, disabled },
    on: { changed },
    providers: [
      { provide: IdentityServerService, useValue: identity },
      MockProvider(TrnSurfaceService, {
        open: vi.fn(() => ({ closed }) as never),
      }),
      MockProvider(TrnAlertService, {
        confirm$: vi.fn(() => confirmed.asObservable()),
      }),
    ],
  });
  return {
    ...rendered,
    identity,
    calls,
    changed,
    closed,
    confirmed,
    alert: TestBed.inject(TrnAlertService),
    surfaces: TestBed.inject(TrnSurfaceService),
  };
}

describe('IdentityServerRowComponent', () => {
  it('disables Change and Turn off when disabled', async () => {
    await setup(SET, [], true);

    for (const id of ['identity-server-change', 'identity-server-turn-off']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('shows the host, Change and Turn off for a set server', async () => {
    await setup(SET);

    expect(screen.getByTestId('identity-server-value').textContent).toBe(
      'vector.im',
    );
    expect(screen.getByTestId('identity-server-change')).toBeTruthy();
    expect(screen.getByTestId('identity-server-turn-off')).toBeTruthy();
  });

  it.each([
    [{ kind: 'off' }, 'Off'],
    [{ kind: 'none' }, 'None'],
  ] as const)('shows %j as %s without Turn off', async (choice, text) => {
    await setup(choice);

    expect(screen.getByTestId('identity-server-value').textContent).toBe(text);
    expect(screen.queryByTestId('identity-server-turn-off')).toBeNull();
  });

  it('Change opens the dialog and announces a saved server to the group', async () => {
    const test = await setup(SET, ['a@b.c']);
    fireEvent.click(screen.getByTestId('identity-server-change'));

    expect(test.surfaces.open).toHaveBeenCalledWith(
      ChangeIdentityServerDialogComponent,
      expect.objectContaining({
        inputs: {
          accountId: ALICE,
          current: 'https://vector.im',
          published: ['a@b.c'],
        },
      }),
    );
    test.closed.next({ kind: 'changed' });

    expect(test.changed).toHaveBeenCalledTimes(1);
  });

  it('turns off after a plain confirm when nothing is published', async () => {
    const test = await setup(SET);
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));

    expect(test.alert.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Turn off the identity server?',
        message:
          'Nobody will be able to find you by email until you choose one again.',
        confirmText: 'Turn off',
      }),
    );
    test.confirmed.next(true);

    expect(test.calls).toEqual(['turnOff']);
    expect(test.changed).toHaveBeenCalledTimes(1);
  });

  it('names the count, then unpublishes before turning off', async () => {
    const test = await setup(SET, ['a@b.c', 'd@e.f']);
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));

    expect(test.alert.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Trinity will first stop vector.im from finding you by 2 addresses.',
      }),
    );
    test.confirmed.next(true);

    expect(test.identity.unpublishAll).toHaveBeenCalledWith(
      ALICE,
      'https://vector.im',
      ['a@b.c', 'd@e.f'],
    );
    expect(test.calls).toEqual(['unpublishAll', 'turnOff']);
  });

  it('uses the singular for one published address', async () => {
    const test = await setup(SET, ['a@b.c']);
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));

    expect(test.alert.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Trinity will first stop vector.im from finding you by 1 address.',
      }),
    );
  });

  it('leaves the server unchanged when unpublishing is refused', async () => {
    const test = await setup(SET, ['a@b.c']);
    test.identity.unpublishAll.mockReturnValue(
      of({ kind: 'refused', reason: 'unreachable' } as never),
    );
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));
    test.confirmed.next(true);
    await test.fixture.whenStable();
    test.fixture.detectChanges();

    expect(test.identity.turnOff).not.toHaveBeenCalled();
    expect(test.changed).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId('identity-server-row-error').textContent,
    ).toContain('Trinity couldn’t reach vector.im. Try again later.');
  });

  it('emits changed after a partial unpublish so the list is re-read', async () => {
    const test = await setup(SET, ['a@b.c']);
    test.identity.unpublishAll.mockReturnValue(
      of({ kind: 'refused', reason: 'unreachable' }),
    );
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));
    test.confirmed.next(true);

    expect(test.changed).toHaveBeenCalledTimes(1);
  });

  it('says the homeserver could not save when turning off is refused', async () => {
    const test = await setup(SET);
    test.identity.turnOff.mockReturnValue(
      of({ kind: 'refused', reason: 'failed' }) as never,
    );
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));
    test.confirmed.next(true);
    await test.fixture.whenStable();
    test.fixture.detectChanges();

    expect(
      screen.getByTestId('identity-server-row-error').textContent,
    ).toContain('Trinity couldn’t save that change on example.org. Try again.');
    expect(test.changed).not.toHaveBeenCalled();
  });

  it('names the buttons in context', async () => {
    await setup(SET);

    expect(
      screen.getByRole('button', { name: 'Change identity server' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Turn off identity server' }),
    ).toBeTruthy();
  });

  it('emits changed and shows the message after a partial dialog close', async () => {
    const test = await setup(SET, ['a@b.c']);
    fireEvent.click(screen.getByTestId('identity-server-change'));
    test.closed.next({ kind: 'partial', message: 'Trinity couldn’t reach x.' });
    test.fixture.detectChanges();

    expect(test.changed).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId('identity-server-row-error').textContent,
    ).toContain('couldn’t reach x');
  });

  it('does nothing when the confirm is cancelled', async () => {
    const test = await setup(SET, ['a@b.c']);
    fireEvent.click(screen.getByTestId('identity-server-turn-off'));
    test.confirmed.next(false);

    expect(test.identity.unpublishAll).not.toHaveBeenCalled();
    expect(test.identity.turnOff).not.toHaveBeenCalled();
  });
});
