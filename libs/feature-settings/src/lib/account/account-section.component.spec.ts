import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, type AccountManagement } from '@trinity/data-access-auth';
import { TrnToastService } from '@trinity/helm/overlay';
import { AccountSectionComponent } from './account-section.component';

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn().mockResolvedValue(undefined) },
}));
import { Browser } from '@capacitor/browser';

/**
 * Fill the three password boxes through the form's own fields — the same writable
 * signals the inputs bind to, so a test drives the component the way a user would
 * rather than through an accessor that exists only for tests.
 */
function fill(
  cmp: AccountSectionComponent,
  values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  },
): void {
  cmp.form.currentPassword().value.set(values.currentPassword);
  cmp.form.newPassword().value.set(values.newPassword);
  cmp.form.confirmPassword().value.set(values.confirmPassword);
}

describe('AccountSectionComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderSection(management: AccountManagement | null = null) {
    const result = await render(AccountSectionComponent, {
      providers: [
        // getAccountManagement is read in the constructor, so it must be stubbed
        // before construction (not after render).
        MockProvider(AuthService, {
          getAccountManagement: () => of(management),
        }),
        MockProvider(TrnToastService),
      ],
    });
    const auth = TestBed.inject(AuthService);
    const toast = TestBed.inject(TrnToastService);
    // changePassword is a cold Observable the component feeds to runWithBusy.
    vi.mocked(auth.changePassword).mockReturnValue(of(undefined));
    return { ...result, cmp: result.fixture.componentInstance, auth, toast };
  }

  it('shows a provider link (no password form) for an OIDC account', async () => {
    const { cmp } = await renderSection({
      url: 'https://op.example/account',
      actionsSupported: [],
    });

    expect(cmp.accountManagement()?.url).toBe('https://op.example/account');
    // The in-app password form is replaced by the "Manage account" link.
    expect(screen.queryByTestId('change-password')).toBeNull();
    expect(screen.getByTestId('manage-account')).toBeTruthy();

    cmp.openAccountManagement();
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://op.example/account',
    });
  });

  it('reveals each password field independently', async () => {
    const { cmp, fixture } = await renderSection();
    const field = (id: string) => screen.getByTestId(id) as HTMLInputElement;

    // All three start masked.
    expect(field('current-password').type).toBe('password');
    expect(field('new-password').type).toBe('password');
    expect(field('confirm-password').type).toBe('password');

    // Toggling one reveals only that field.
    cmp.toggleReveal('currentPassword');
    fixture.detectChanges();
    expect(field('current-password').type).toBe('text');
    expect(field('new-password').type).toBe('password');
    expect(cmp.revealed()).toEqual({
      currentPassword: true,
      newPassword: false,
      confirmPassword: false,
    });

    // Toggling again re-masks it.
    cmp.toggleReveal('currentPassword');
    fixture.detectChanges();
    expect(field('current-password').type).toBe('password');
  });

  it('changes the password, clears the form, and toasts on success', async () => {
    const { cmp, auth, toast } = await renderSection();
    fill(cmp, {
      currentPassword: 'old-pw',
      newPassword: 'new-secret-pw',
      confirmPassword: 'new-secret-pw',
    });

    // Typing into a field and leaving it is what marks it touched in the browser;
    // value.set() alone never does, so without this the assertion below cannot fail.
    cmp.form().markAsTouched();

    cmp.submit();

    expect(auth.changePassword).toHaveBeenCalledWith('old-pw', 'new-secret-pw');
    expect(cmp.form.newPassword().value()).toBe(''); // reset()
    // Cleared AND untouched. Emptying the values alone leaves three now-invalid
    // required fields marked touched, which is a primed error state — the reason
    // this asserts the flag and not just the value.
    expect(cmp.form.newPassword().touched()).toBe(false);
    expect(cmp.form.currentPassword().touched()).toBe(false);
    expect(cmp.error()).toBeNull();
    expect(toast.show).toHaveBeenCalledWith(
      'Password changed.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('refuses a mismatched confirmation without calling the service', async () => {
    const { cmp, auth } = await renderSection();
    fill(cmp, {
      currentPassword: 'old-pw',
      newPassword: 'new-secret-pw',
      confirmPassword: 'different-pw',
    });

    cmp.submit();

    expect(cmp.error()).toContain('don’t match');
    expect(auth.changePassword).not.toHaveBeenCalled();
  });

  it('refuses reusing the current password', async () => {
    const { cmp, auth } = await renderSection();
    fill(cmp, {
      currentPassword: 'same-secret-pw',
      newPassword: 'same-secret-pw',
      confirmPassword: 'same-secret-pw',
    });

    cmp.submit();

    expect(cmp.error()).toContain('different');
    expect(auth.changePassword).not.toHaveBeenCalled();
  });

  it('blocks a too-short new password (form invalid)', async () => {
    const { cmp, auth } = await renderSection();
    fill(cmp, {
      currentPassword: 'old-pw',
      newPassword: 'short',
      confirmPassword: 'short',
    });

    cmp.submit();

    expect(cmp.error()).toContain('at least');
    expect(auth.changePassword).not.toHaveBeenCalled();
  });

  it('shows the service error inline and keeps the form intact', async () => {
    const { cmp, auth, toast } = await renderSection();
    vi.mocked(auth.changePassword).mockReturnValue(
      throwError(() => new Error('Your current password is incorrect.')),
    );
    fill(cmp, {
      currentPassword: 'wrong-pw',
      newPassword: 'new-secret-pw',
      confirmPassword: 'new-secret-pw',
    });

    cmp.submit();

    expect(cmp.error()).toBe('Your current password is incorrect.');
    expect(cmp.form.newPassword().value()).toBe('new-secret-pw'); // not reset
    expect(toast.show).not.toHaveBeenCalled();
  });
});
