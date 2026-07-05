import { render } from '@testing-library/angular';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AvatarComponent } from './avatar.component';
import { AVATAR_RESOLVER } from './avatar-resolver';

// The image-shows-once-loaded / falls-back-on-error swap is BrnAvatar's job (and
// needs a real image load, which jsdom can't do), so these cover the component's
// own contract: the resolved `src`, and the initials fallback that renders while
// there's no image. The rendered image path is verified in the browser (e2e).
describe('AvatarComponent', () => {
  const fallback = (host: HTMLElement) =>
    host.querySelector('[data-slot="avatar-fallback"]');

  it('shows the initials fallback when no image source is given', async () => {
    const { fixture, container } = await render(AvatarComponent, {
      inputs: { initial: 'A', name: 'Alice' },
    });

    expect(fixture.componentInstance.src()).toBeNull();
    const fb = fallback(container);
    expect(fb).toBeTruthy();
    expect(fb?.textContent?.trim()).toBe('A');
  });

  it('uses the direct url as the image source', async () => {
    const { fixture } = await render(AvatarComponent, {
      inputs: { url: 'https://hs.example/avatar.png' },
    });

    expect(fixture.componentInstance.src()).toBe(
      'https://hs.example/avatar.png',
    );
  });

  it('resolves an mxc via the resolver and uses the resolved url', async () => {
    const resolver = vi.fn(() => of('blob:resolved'));
    const { fixture } = await render(AvatarComponent, {
      inputs: { mxc: 'mxc://hs/a', size: 64 },
      providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
    });

    expect(resolver).toHaveBeenCalledWith('mxc://hs/a', 64);
    expect(fixture.componentInstance.src()).toBe('blob:resolved');
  });

  it('falls back to initials when the resolver yields null', async () => {
    const { fixture, container } = await render(AvatarComponent, {
      inputs: { mxc: 'mxc://hs/missing', initial: 'C' },
      providers: [{ provide: AVATAR_RESOLVER, useValue: () => of(null) }],
    });

    expect(fixture.componentInstance.src()).toBeNull();
    expect(fallback(container)?.textContent?.trim()).toBe('C');
  });
});
