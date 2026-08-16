import { TrnDialogRef } from '@trinity/helm/overlay';
import { render } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  PushGatewayTrustDialogComponent,
  type PushGatewayTrustData,
} from './push-gateway-trust-dialog.component';

function setup(data: PushGatewayTrustData) {
  const close = vi.fn();
  return render(PushGatewayTrustDialogComponent, {
    // `data` arrives as a required input, the way TrnDialogService.open applies its
    // `inputs` bag — the render wrapper calls setInput before the first change
    // detection, so the computed that reads it never sees an unset signal.
    inputs: { data },
    providers: [{ provide: TrnDialogRef, useValue: { close } }],
  }).then((r) => ({ ...r, close }));
}

const HTTPS: PushGatewayTrustData = {
  url: 'https://push.example.org/_matrix/push/v1/notify',
  insecure: false,
};

describe('PushGatewayTrustDialogComponent', () => {
  it('names the gateway host and what it can see', async () => {
    const { container } = await setup(HTTPS);

    expect(container.textContent).toContain('push.example.org');
    expect(container.textContent).toContain('your Matrix ID');
    // The reassurance half must be present too, not just the scary half.
    expect(container.textContent).toContain('not');
    expect(container.textContent?.toLowerCase()).toContain('never its content');
  });

  it('omits the plain-text warning for an https gateway', async () => {
    const { container } = await setup(HTTPS);
    expect(
      container.querySelector('[data-testid=push-gateway-trust-insecure]'),
    ).toBeNull();
  });

  it('shows the plain-text warning for an http gateway', async () => {
    const { container } = await setup({
      url: 'http://192.168.1.10:5000/_matrix/push/v1/notify',
      insecure: true,
    });
    expect(
      container.querySelector('[data-testid=push-gateway-trust-insecure]'),
    ).not.toBeNull();
  });

  it('resolves true on confirm and false on cancel', async () => {
    const { container, close } = await setup(HTTPS);

    container
      .querySelector<HTMLButtonElement>(
        '[data-testid=push-gateway-trust-confirm]',
      )
      ?.click();
    expect(close).toHaveBeenCalledWith(true);

    container
      .querySelector<HTMLButtonElement>(
        '[data-testid=push-gateway-trust-cancel]',
      )
      ?.click();
    expect(close).toHaveBeenCalledWith(false);
  });
});
