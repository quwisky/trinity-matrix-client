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

  const dot = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('.presence-dot');

  it('renders no presence dot by default', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: { initial: 'A' },
    });
    expect(dot(container)).toBeNull();
  });

  it('renders a labelled presence dot coloured for the state', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: { initial: 'A', presence: 'online' },
    });
    const el = dot(container);
    expect(el).toBeTruthy();
    expect(el?.getAttribute('data-presence')).toBe('online');
    expect(el?.getAttribute('aria-label')).toBe('Online');
    expect(el?.style.background).toBe('rgb(35, 165, 90)'); // #23a55a
  });

  it('shows an amber Away dot for the unavailable state', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: { initial: 'A', presence: 'unavailable' },
    });
    const el = dot(container);
    expect(el?.getAttribute('aria-label')).toBe('Away');
    expect(el?.style.background).toBe('rgb(240, 178, 50)'); // #f0b232
  });

  it('scales the dot to the avatar size', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: { initial: 'A', presence: 'offline', size: 64 },
    });
    expect(dot(container)?.style.width).toBe('19px'); // round(64 * 0.3)
  });

  it('floors the dot at 8px for small avatars', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: { initial: 'A', presence: 'offline', size: 20 },
    });
    expect(dot(container)?.style.width).toBe('8px'); // round(20 * 0.3) = 6 → floored
  });
});
