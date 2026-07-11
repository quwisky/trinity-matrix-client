import { render } from '@testing-library/angular';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AVATAR_RESOLVER } from '@trinity/ui';
import { StickerComponent } from './sticker.component';

async function build(
  inputs: { mxc?: string | null; label?: string; size?: number },
  resolver = vi.fn(() => of<string | null>('blob:sticker')),
) {
  const { container } = await render(StickerComponent, {
    inputs: { mxc: null, label: 'Sticker', ...inputs },
    providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
  });
  return { container, resolver };
}

describe('StickerComponent', () => {
  it('resolves the mxc through the resolver and renders the image', async () => {
    const { container, resolver } = await build({
      mxc: 'mxc://hs/party',
      label: 'Party Blob',
      size: 64,
    });

    expect(resolver).toHaveBeenCalledWith('mxc://hs/party', 64);
    const img = container.querySelector<HTMLImageElement>(
      '[data-testid=sticker-image]',
    );
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:sticker');
    expect(img?.getAttribute('alt')).toBe('Party Blob');
  });

  it('renders nothing until the image resolves', async () => {
    const { container } = await build(
      { mxc: 'mxc://hs/x' },
      vi.fn(() => of<string | null>(null)),
    );
    expect(container.querySelector('[data-testid=sticker-image]')).toBeNull();
  });

  it('renders nothing without an mxc', async () => {
    const resolver = vi.fn(() => of<string | null>('blob:x'));
    const { container } = await build({ mxc: null }, resolver);
    expect(resolver).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid=sticker-image]')).toBeNull();
  });
});
