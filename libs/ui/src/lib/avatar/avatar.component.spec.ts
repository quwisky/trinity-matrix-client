import { render } from '@trinity/testing';
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

  // Deliberately a second, independent implementation of the WCAG maths rather
  // than an import of the component's helper — otherwise a regression in that
  // helper would be mirrored here and the assertion would pass regardless.
  const luminance = (hex: string) => {
    const linear = (offset: number) => {
      const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
  };
  const contrast = (background: string, ink: string) => {
    const [a, b] = [luminance(background), luminance(ink)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  // Asserts the *property* (AA is met), not the six literal picks — pinning the
  // current choices would just re-freeze whatever the implementation happens to do.
  it('picks an initial colour that clears WCAG AA on every hashed background', async () => {
    const { fixture } = await render(AvatarComponent, {
      inputs: { name: 'user-0' },
    });
    const avatar = fixture.componentInstance;

    const inkByBackground = new Map<string, string>();
    for (let i = 0; i < 60; i++) {
      fixture.componentRef.setInput('name', `user-${i}`);
      inkByBackground.set(avatar.color(), avatar.initialColor());
    }

    expect(inkByBackground.size).toBe(6); // the whole hash palette is exercised
    inkByBackground.forEach((ink, background) => {
      expect(contrast(background, ink)).toBeGreaterThanOrEqual(4.5);
    });
  });

  const badge = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('[data-testid="account-badge"]');

  it('renders no account badge by default', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: { initial: 'R', name: 'Room' },
    });
    expect(badge(container)).toBeNull();
  });

  it('renders the account badge with the account initial and label', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: {
        initial: 'R',
        name: 'Room',
        accountBadge: { id: '@work:hs', initial: 'W', name: 'Work' },
      },
    });
    const el = badge(container)!;
    expect(el.textContent?.trim()).toBe('W');
    expect(el.getAttribute('aria-label')).toBe('Account: Work (@work:hs)');
    expect(el.getAttribute('title')).toBe('Work (@work:hs)');
  });

  it('colours the badge from the account name (not the row) and keeps its letter legible', async () => {
    const { fixture } = await render(AvatarComponent, {
      inputs: {
        name: 'Room A',
        accountBadge: { id: '@work:hs', initial: 'W', name: 'Work' },
      },
    });
    const avatar = fixture.componentInstance;
    const badgeColor = avatar.badgeColor();
    expect(contrast(badgeColor, avatar.badgeInk())).toBeGreaterThanOrEqual(4.5);

    // Changing the row name must not move the account badge's colour — it's hashed
    // from the account, not the row.
    fixture.componentRef.setInput('name', 'A completely different room');
    expect(avatar.badgeColor()).toBe(badgeColor);
  });

  const badgeImg = (host: HTMLElement) =>
    host.querySelector<HTMLImageElement>('.account-badge__img');

  it('shows the account’s real avatar in the badge, resolved from its mxc', async () => {
    const resolver = vi.fn(() => of('blob:account-avatar'));
    const { container, fixture } = await render(AvatarComponent, {
      inputs: {
        initial: 'R',
        name: 'Room',
        accountBadge: {
          id: '@work:hs',
          initial: 'W',
          name: 'Work',
          avatarMxc: 'mxc://hs/work',
        },
      },
      providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
    });

    // Resolved at the badge's own (smaller) size, not the avatar's.
    // Resolved through the OWNING account's client, not the active one.
    expect(resolver).toHaveBeenCalledWith(
      'mxc://hs/work',
      fixture.componentInstance.badgeSize(),
      '@work:hs',
    );
    const img = badgeImg(container)!;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('blob:account-avatar');
    // With an image the initial letter is not also rendered.
    expect(badge(container)?.textContent?.trim()).toBe('');
  });

  it('falls back to the account initial when the badge avatar cannot be resolved', async () => {
    const { container } = await render(AvatarComponent, {
      inputs: {
        initial: 'R',
        name: 'Room',
        accountBadge: {
          id: '@work:hs',
          initial: 'W',
          name: 'Work',
          avatarMxc: 'mxc://hs/missing',
        },
      },
      providers: [{ provide: AVATAR_RESOLVER, useValue: () => of(null) }],
    });

    expect(badgeImg(container)).toBeNull();
    expect(badge(container)?.textContent?.trim()).toBe('W');
  });

  it('shows the initial when the account has no avatar (no resolver call)', async () => {
    const resolver = vi.fn(() => of('blob:should-not-be-used'));
    const { container } = await render(AvatarComponent, {
      inputs: {
        initial: 'R',
        name: 'Room',
        accountBadge: {
          id: '@work:hs',
          initial: 'W',
          name: 'Work',
          avatarMxc: null,
        },
      },
      providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(badgeImg(container)).toBeNull();
    expect(badge(container)?.textContent?.trim()).toBe('W');
  });

  // Avatar instances are recycled across @for rows, so a badge that changes account must
  // not keep the previous account's face under the new account's label.
  it('re-resolves the badge avatar when the row is reused for another account', async () => {
    const resolver = vi.fn((mxc: string) => of(`blob:${mxc}`));
    const { container, fixture } = await render(AvatarComponent, {
      inputs: {
        accountBadge: {
          id: '@work:hs',
          initial: 'W',
          name: 'Work',
          avatarMxc: 'mxc://hs/work',
        },
      },
      providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
    });
    expect(badgeImg(container)?.getAttribute('src')).toBe('blob:mxc://hs/work');

    // Recycled onto a row owned by an account that has no avatar → back to the initial.
    fixture.componentRef.setInput('accountBadge', {
      id: '@alt:hs',
      initial: 'A',
      name: 'Alt',
      avatarMxc: null,
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.badgeSrc()).toBeNull();
    expect(badgeImg(container)).toBeNull();
    expect(badge(container)?.textContent?.trim()).toBe('A');

    // …and onto one that has a different avatar → that account's image.
    fixture.componentRef.setInput('accountBadge', {
      id: '@alt:hs',
      initial: 'A',
      name: 'Alt',
      avatarMxc: 'mxc://hs/alt',
    });
    fixture.detectChanges();
    expect(badgeImg(container)?.getAttribute('src')).toBe('blob:mxc://hs/alt');
  });

  it('does not re-resolve when the host rebuilds an equal badge object', async () => {
    const resolver = vi.fn(() => of('blob:work'));
    const { fixture } = await render(AvatarComponent, {
      inputs: {
        accountBadge: {
          id: '@work:hs',
          initial: 'W',
          name: 'Work',
          avatarMxc: 'mxc://hs/work',
        },
      },
      providers: [{ provide: AVATAR_RESOLVER, useValue: resolver }],
    });
    expect(resolver).toHaveBeenCalledTimes(1);

    // The rooms page rebuilds its badge map (fresh objects, same contents) on every sync
    // tick. Re-fetching then would hammer the resolver — which doesn't cache failures.
    fixture.componentRef.setInput('accountBadge', {
      id: '@work:hs',
      initial: 'W',
      name: 'Work',
      avatarMxc: 'mxc://hs/work',
    });
    fixture.detectChanges();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('falls back to the initial when the resolved badge image fails to load', async () => {
    const { container, fixture } = await render(AvatarComponent, {
      inputs: {
        accountBadge: {
          id: '@work:hs',
          initial: 'W',
          name: 'Work',
          avatarMxc: 'mxc://hs/work',
        },
      },
      providers: [
        { provide: AVATAR_RESOLVER, useValue: () => of('blob:broken') },
      ],
    });
    const img = badgeImg(container);
    expect(img).toBeTruthy();

    // An undecodable blob would otherwise pin a broken-image glyph in the corner.
    img!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(badgeImg(container)).toBeNull();
    expect(badge(container)?.textContent?.trim()).toBe('W');
  });
});
