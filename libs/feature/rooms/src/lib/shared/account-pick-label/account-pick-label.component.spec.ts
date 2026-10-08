import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { AccountPickLabelComponent } from './account-pick-label.component';

const ACCOUNT = {
  userId: '@alice:hs',
  displayName: 'Alice',
  avatarMxc: null,
};

describe('AccountPickLabelComponent', () => {
  it('shows the avatar initial, the name and the Matrix ID', async () => {
    const { container } = await render(AccountPickLabelComponent, {
      inputs: { account: ACCOUNT },
    });

    expect(container.querySelector('trn-avatar')?.textContent).toContain('A');
    expect(container.querySelector('.account-pick__name')?.textContent).toBe(
      'Alice',
    );
    expect(container.querySelector('.account-pick__handle')?.textContent).toBe(
      '@alice:hs',
    );
  });

  it('shows ? for an account with no visible name', async () => {
    const { container } = await render(AccountPickLabelComponent, {
      inputs: { account: { ...ACCOUNT, displayName: '' } },
    });

    expect(container.querySelector('trn-avatar')?.textContent).toContain('?');
  });

  it('does not say "Always included" for an unlocked account', async () => {
    const { container } = await render(AccountPickLabelComponent, {
      inputs: { account: ACCOUNT },
    });

    expect(container.textContent).not.toContain('Always included');
  });

  it('says "Always included" for a locked account', async () => {
    const { container } = await render(AccountPickLabelComponent, {
      inputs: { account: ACCOUNT, locked: true },
    });

    expect(container.querySelector('.account-pick__active')?.textContent).toBe(
      'Always included',
    );
  });
});
