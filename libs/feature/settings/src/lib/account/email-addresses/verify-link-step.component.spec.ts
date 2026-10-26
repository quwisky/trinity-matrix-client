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

  it('builds its test ids from testIdPrefix', async () => {
    const { emitted } = await setup({ testIdPrefix: 'publish-email' });

    fireEvent.click(screen.getByTestId('publish-email-continue'));
    fireEvent.click(screen.getByTestId('publish-email-resend'));
    fireEvent.click(screen.getByTestId('publish-email-cancel'));

    expect(emitted).toEqual(['continue', 'resend', 'cancel']);
    expect(screen.getByTestId('publish-email-sent')).toBeTruthy();
    expect(screen.queryByTestId('add-email-continue')).toBeNull();
  });

  it('builds the body id from the prefix, so each dialog describes itself', async () => {
    const { container } = await setup();
    expect(container.querySelector('#add-email-body')).toBeTruthy();
  });

  it('uses a prefixed body id and a caller-given body', async () => {
    const { container } = await setup({
      testIdPrefix: 'publish-email',
      body: 'vector.im sent a link.',
    });

    expect(
      container.querySelector('#publish-email-body')?.textContent?.trim(),
    ).toBe('vector.im sent a link.');
    expect(container.querySelector('#add-email-body')).toBeNull();
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
