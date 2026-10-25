import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@trinity/testing';
import { ReauthPasswordStepComponent } from './reauth-password-step.component';

async function setup(rejected = false, variant?: 'danger' | 'primary') {
  const submitted = vi.fn();
  const back = vi.fn();
  const rendered = await render(ReauthPasswordStepComponent, {
    inputs: {
      testIdPrefix: 'add-email',
      body: 'Enter your password to continue.',
      rejected,
      rejectedMessage: 'That password is incorrect.',
      submitLabel: 'Continue',
      ...(variant ? { variant } : {}),
    },
    on: { submitted, back },
  });
  return { ...rendered, submitted, back };
}

describe('ReauthPasswordStepComponent', () => {
  it.each([
    [undefined, 'primary'],
    ['danger', 'danger'],
  ] as const)('renders submit with variant %s as %s', async (given, shown) => {
    await setup(false, given);

    expect(
      screen
        .getByTestId('add-email-password-submit')
        .getAttribute('data-trn-variant'),
    ).toBe(shown);
  });

  it('emits the typed password and forgets it', async () => {
    const test = await setup();
    const field = screen.getByLabelText('Password') as HTMLInputElement;

    expect(field.id).toBe('add-email-password');
    fireEvent.input(field, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(test.submitted).toHaveBeenCalledWith('secret');
    await test.fixture.whenStable();
    test.fixture.detectChanges();
    expect(field.value).toBe('');
  });

  it('does not emit an empty password and keeps focus on the field', async () => {
    const test = await setup();

    fireEvent.click(screen.getByTestId('add-email-password-submit'));
    await test.fixture.whenStable();

    expect(test.submitted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByTestId('add-email-password'),
    );
  });

  it('shows the rejected message next to the field when rejected', async () => {
    const test = await setup(true);
    const field = screen.getByTestId('add-email-password');

    expect(
      screen.getByTestId('add-email-password-error').textContent,
    ).toContain('That password is incorrect.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(
      'add-email-password-error',
    );
    const results = await axe.run(test.container, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('emits back', async () => {
    const test = await setup();

    fireEvent.click(screen.getByTestId('add-email-back'));

    expect(test.back).toHaveBeenCalled();
  });
});
