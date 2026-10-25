import { Subject, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnAlertService, TrnDialogRef } from '@trinity/components/overlay';
import { IdentityServerService } from '@trinity/data-access/contact-addresses';
import { fireEvent, render, screen } from '@trinity/testing';
import { ChangeIdentityServerDialogComponent } from './change-identity-server-dialog.component';

const ALICE = '@alice:example.org';

async function setup(published: readonly string[] = []) {
  const confirmed = new Subject<boolean>();
  const calls: string[] = [];
  const identity = {
    unpublishAll: vi.fn((): Observable<unknown> => {
      calls.push('unpublishAll');
      return of({ kind: 'unpublished' });
    }),
    use: vi.fn((): Observable<unknown> => {
      calls.push('use');
      return of({ kind: 'saved', url: 'https://new.example' });
    }),
  };
  const close = vi.fn();
  const confirm$ = vi.fn(() => confirmed.asObservable());
  const rendered = await render(ChangeIdentityServerDialogComponent, {
    inputs: { accountId: ALICE, current: 'https://vector.im', published },
    providers: [
      { provide: IdentityServerService, useValue: identity },
      { provide: TrnAlertService, useValue: { confirm$ } },
      { provide: TrnDialogRef, useValue: { close, titleId: 't' } },
    ],
  });
  return { ...rendered, identity, calls, close, confirm$, confirmed };
}

async function save(test: Awaited<ReturnType<typeof setup>>, value: string) {
  fireEvent.input(screen.getByTestId('identity-server-url-input'), {
    target: { value },
  });
  fireEvent.click(screen.getByTestId('identity-server-save'));
  await test.fixture.whenStable();
  test.fixture.detectChanges();
}

describe('ChangeIdentityServerDialogComponent', () => {
  it('rejects an http address without calling use', async () => {
    const test = await setup();
    await save(test, 'http://new.example');

    expect(screen.getByTestId('identity-server-error').textContent).toContain(
      'Use an address that starts with https://.',
    );
    expect(test.identity.use).not.toHaveBeenCalled();
  });

  it('shows the not-identity-server copy', async () => {
    const test = await setup();
    test.identity.use.mockReturnValue(
      of({ kind: 'refused', reason: 'not-identity-server' }),
    );
    await save(test, 'https://new.example');

    expect(screen.getByTestId('identity-server-error').textContent).toContain(
      'Trinity couldn’t find an identity server at that address.',
    );
    expect(test.close).not.toHaveBeenCalled();
  });

  it('closes as changed on success', async () => {
    const test = await setup();
    await save(test, ' https://new.example ');

    expect(test.identity.use).toHaveBeenCalledWith(
      ALICE,
      'https://new.example',
    );
    expect(test.close).toHaveBeenCalledWith({ kind: 'changed' });
  });

  it('confirms with the count, then unpublishes from the old server before use', async () => {
    const test = await setup(['a@b.c']);
    await save(test, 'https://new.example');

    expect(test.confirm$).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Change identity server?',
        message:
          'Trinity will first stop vector.im from finding you by 1 address.',
      }),
    );
    expect(test.identity.use).not.toHaveBeenCalled();
    test.confirmed.next(true);

    expect(test.identity.unpublishAll).toHaveBeenCalledWith(
      ALICE,
      'https://vector.im',
      ['a@b.c'],
    );
    expect(test.calls).toEqual(['unpublishAll', 'use']);
  });

  it('keeps the server when unpublishing is refused', async () => {
    const test = await setup(['a@b.c']);
    test.identity.unpublishAll.mockReturnValue(
      of({ kind: 'refused', reason: 'unreachable' }),
    );
    await save(test, 'https://new.example');
    test.confirmed.next(true);
    test.fixture.detectChanges();

    expect(test.identity.use).not.toHaveBeenCalled();
    expect(test.close).not.toHaveBeenCalled();
    expect(screen.getByTestId('identity-server-error').textContent).toContain(
      'Trinity couldn’t reach vector.im. Try again later.',
    );
  });
});
