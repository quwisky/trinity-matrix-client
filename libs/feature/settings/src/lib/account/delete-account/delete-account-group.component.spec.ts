import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  ACCOUNT_DELETION_LAUNCHER,
  type AccountDeletionLauncher,
  type AccountDeletionOutcome,
  type AccountDeletionPlan,
} from '@trinity/platform-native';
import { fireEvent, render, screen } from '@trinity/testing';
import { DeleteAccountDialogComponent } from './delete-account-dialog.component';
import { DeleteAccountGroupComponent } from './delete-account-group.component';

const ALICE = '@alice:example.org';

async function setup(
  plan: AccountDeletionPlan,
  checked: AccountDeletionOutcome = { kind: 'kept', reason: 'still-active' },
) {
  const launcher: Partial<AccountDeletionLauncher> = {
    plan: vi.fn(() => of(plan)),
    openProvider: vi.fn(() => of(true)),
    checkDeletion: vi.fn(() => of(checked)),
  };
  const rendered = await render(DeleteAccountGroupComponent, {
    inputs: { accountId: ALICE },
    providers: [
      { provide: ACCOUNT_DELETION_LAUNCHER, useValue: launcher },
      MockProvider(TrnSurfaceService, { open: vi.fn() }),
    ],
  });
  return {
    ...rendered,
    launcher,
    surfaces: TestBed.inject(TrnSurfaceService),
  };
}

describe('DeleteAccountGroupComponent', () => {
  it('opens the deletion dialog for the account it shows', async () => {
    const test = await setup({ kind: 'in-app' });

    expect(test.launcher.plan).toHaveBeenCalledWith(ALICE);
    expect(
      screen.getByText(`Close ${ALICE} for good. This can’t be undone.`),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));

    expect(test.surfaces.open).toHaveBeenCalledWith(
      DeleteAccountDialogComponent,
      expect.objectContaining({ inputs: { accountId: ALICE } }),
    );
  });

  it('refuses to be dismissed while the dialog says so', async () => {
    const test = await setup({ kind: 'in-app' });
    fireEvent.click(screen.getByTestId('delete-account'));

    const options = vi.mocked(test.surfaces.open).mock.calls[0][1]!;
    expect(options.dismissGuard?.({ canDismiss: () => false } as never)).toBe(
      false,
    );
  });

  it('links to the provider page on an OAuth server, naming its host', async () => {
    const test = await setup({
      kind: 'provider',
      url: 'https://auth.example.org/account/',
    });

    expect(screen.queryByTestId('delete-account')).toBeNull();
    expect(
      screen.getByText(
        'Your account is managed by example.org’s sign-in provider. You delete it there.',
      ),
    ).toBeTruthy();
    const button = screen.getByRole('button', {
      name: 'Delete account at provider',
    });
    expect(button.getAttribute('aria-describedby')).toBe(
      'delete-account-provider-hint',
    );
    expect(
      screen.getByText('Opens auth.example.org in your browser.'),
    ).toBeTruthy();

    fireEvent.click(button);
    await test.fixture.whenStable();

    expect(test.launcher.openProvider).toHaveBeenCalledWith(
      ALICE,
      'https://auth.example.org/account/',
    );
    expect(
      screen.getByText(
        'After you delete your account there, come back to Trinity. It removes the account from this device when it notices.',
      ),
    ).toBeTruthy();
  });

  it('reports an account that still exists after Check now', async () => {
    const test = await setup({
      kind: 'provider',
      url: 'https://auth.example.org/account/',
    });
    fireEvent.click(screen.getByTestId('delete-account-provider'));
    await test.fixture.whenStable();
    fireEvent.click(screen.getByTestId('delete-account-check-now'));
    await test.fixture.whenStable();

    expect(test.launcher.checkDeletion).toHaveBeenCalledWith(ALICE);
    expect(
      screen.getByTestId('delete-account-check-result').textContent,
    ).toContain(
      'Your account still exists. If you deleted it, wait a moment and check again.',
    );
  });

  it('says why Check now could not ask', async () => {
    const test = await setup(
      { kind: 'provider', url: 'https://auth.example.org/account/' },
      { kind: 'kept', reason: 'busy' },
    );
    fireEvent.click(screen.getByTestId('delete-account-provider'));
    await test.fixture.whenStable();
    fireEvent.click(screen.getByTestId('delete-account-check-now'));
    await test.fixture.whenStable();

    expect(
      screen.getByTestId('delete-account-check-result').textContent,
    ).toContain('Trinity is busy signing out or switching accounts.');
  });

  it('says so when the provider publishes no page', async () => {
    await setup({ kind: 'provider', url: null });

    expect(screen.queryByRole('button')).toBeNull();
    expect(
      screen.getByTestId('delete-account-provider-missing').textContent,
    ).toContain(
      'example.org doesn’t offer a page for deleting accounts. Ask its administrator to delete it.',
    );
  });

  it('says the server could not be asked, and asks again', async () => {
    const test = await setup({ kind: 'unknown' });

    expect(screen.queryByTestId('delete-account')).toBeNull();
    expect(screen.queryByTestId('delete-account-provider')).toBeNull();
    expect(
      screen.getByTestId('delete-account-plan-unknown').textContent,
    ).toContain(
      'Trinity couldn’t load how to delete this account from example.org.',
    );

    vi.mocked(test.launcher.plan!).mockReturnValue(of({ kind: 'in-app' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('delete-account');

    expect(test.launcher.plan).toHaveBeenCalledTimes(2);
  });
});
