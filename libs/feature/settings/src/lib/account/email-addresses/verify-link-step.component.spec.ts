import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@trinity/testing';
import { VerifyLinkStepComponent } from './verify-link-step.component';

async function setup(inputs: Record<string, unknown> = {}) {
  const emitted: string[] = [];
  const rendered = await render(VerifyLinkStepComponent, {
    inputs: { email: 'a@b.c', ...inputs },
    on: {
      continue: () => emitted.push('continue'),
      resend: () => emitted.push('resend'),
      cancelled: () => emitted.push('cancel'),
    },
  });
  return { ...rendered, emitted };
}

describe('VerifyLinkStepComponent', () => {
  it('names the address and emits each action', async () => {
    const { emitted } = await setup();

    expect(screen.getByTestId('add-email-sent').textContent).toContain(
      'We sent a link to a@b.c. Open it, then select Continue.',
    );
    fireEvent.click(screen.getByTestId('add-email-continue'));
    fireEvent.click(screen.getByTestId('add-email-resend'));
    fireEvent.click(screen.getByTestId('add-email-cancel'));

    expect(emitted).toEqual(['continue', 'resend', 'cancel']);
  });

  it('disables Continue and Resend while busy', async () => {
    await setup({ busy: true });

    expect(
      (screen.getByTestId('add-email-continue') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('add-email-resend') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('disables only Resend while waiting', async () => {
    await setup({ resendWaitMs: 5000 });

    expect(
      (screen.getByTestId('add-email-resend') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('add-email-continue') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('says when the link has not been opened, and passes axe', async () => {
    const { container } = await setup({ notVerified: true, resent: true });

    expect(screen.getByTestId('add-email-not-verified').textContent).toContain(
      'That link hasn’t been opened yet.',
    );
    const results = await axe.run(container, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
