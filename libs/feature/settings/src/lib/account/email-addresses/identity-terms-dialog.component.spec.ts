import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { TrnDialogRef } from '@trinity/components/overlay';
import type { IdentityPolicy } from '@trinity/data-access/contact-addresses';
import { fireEvent, render, screen } from '@trinity/testing';
import { IdentityTermsDialogComponent } from './identity-terms-dialog.component';

const POLICIES: readonly IdentityPolicy[] = [
  {
    id: 'tos',
    name: 'Terms of Service',
    url: 'https://vector.im/tos',
    version: '1',
  },
  {
    id: 'privacy',
    name: 'Privacy Policy',
    url: 'https://vector.im/privacy',
    version: '1',
  },
];

async function setup() {
  const close = vi.fn();
  const rendered = await render(IdentityTermsDialogComponent, {
    inputs: { host: 'vector.im', policies: POLICIES },
    providers: [{ provide: TrnDialogRef, useValue: { close, titleId: 't' } }],
  });
  return { ...rendered, close };
}

describe('IdentityTermsDialogComponent', () => {
  it('names the server and links each policy in a new tab', async () => {
    const { container } = await setup();

    expect(
      screen.getByRole('heading', { name: 'Accept vector.im’s terms' }),
    ).toBeTruthy();
    expect(
      container.querySelector('#identity-terms-body')?.textContent,
    ).toContain(
      'To let people find you by email, vector.im needs you to accept:',
    );
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Terms of Service',
      'Privacy Policy',
    ]);
    expect(links[0].getAttribute('href')).toBe('https://vector.im/tos');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('closes with true on Accept and with nothing on Not now', async () => {
    const { close } = await setup();

    fireEvent.click(screen.getByTestId('identity-terms-decline'));
    expect(close).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByTestId('identity-terms-accept'));
    expect(close).toHaveBeenLastCalledWith(true);
  });

  it('passes axe', async () => {
    const { container } = await setup();
    const results = await axe.run(container, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: false },
      },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
