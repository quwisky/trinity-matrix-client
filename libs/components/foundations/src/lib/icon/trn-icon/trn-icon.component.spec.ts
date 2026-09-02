import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TRN_ICON_MOTIONS } from '../trn-icon-motion';
import { provideTrnIcons } from '../trn-icon.icons';
import { TrnIconComponent } from './trn-icon.component';

const setup = (inputs: Record<string, unknown>) =>
  render(TrnIconComponent, { inputs, providers: [provideTrnIcons()] });

describe('TrnIconComponent', () => {
  it('is decorative by default — nothing announceable, inner icon hidden', async () => {
    const { fixture } = await setup({ name: 'lock' });
    const host = fixture.nativeElement as HTMLElement;

    // The default has to be silence. 112 of the app's 116 icons sit beside text that
    // already says the same thing, so an announced name would be duplicate noise.
    expect(host.getAttribute('role')).toBeNull();
    expect(host.getAttribute('aria-label')).toBeNull();
    expect(host.querySelector('ng-icon')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('announces on the host when labelled, and keeps the inner icon hidden', async () => {
    const { fixture } = await setup({
      name: 'shield-alert',
      label: 'Encrypted',
    });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.getAttribute('role')).toBe('img');
    expect(host.getAttribute('aria-label')).toBe('Encrypted');
    // Announced exactly once, and on the host. Putting the label on the inner
    // <ng-icon> instead is the defect this component replaces: NgIcon force-hides an
    // icon that has no STATIC aria-hidden, so a label written there is suppressed and
    // read by nobody. The icon stays hidden; the host does the talking.
    const inner = host.querySelector('ng-icon');
    expect(inner?.getAttribute('aria-hidden')).toBe('true');
    expect(inner?.getAttribute('aria-label')).toBeNull();
  });

  it('actually renders the SVG for a hyphenated name', async () => {
    // The assertion this spec was missing, and the bug it hid: NgIcon looks up
    // `toPropertyName(name)`, not `name`, so a kebab key registered literally is searched
    // for as camelCase and misses. Every multi-word icon rendered nothing while every
    // ARIA assertion above still passed. Checking for a real <svg> is what closes that.
    const { fixture } = await setup({ name: 'shield-alert' });
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');

    expect(svg).toBeTruthy();
  });

  it('renders the SVG for a single-word name too', async () => {
    const { fixture } = await setup({ name: 'lock' });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('svg'),
    ).toBeTruthy();
  });

  it('treats an empty label as no label, rather than an empty accessible name', async () => {
    // `[attr.x]` only removes the attribute on null, so a naive binding would render
    // `aria-label=""` here — an element that looks announceable and names nothing. An
    // unresolved signal reaching `label` is the ordinary way to hit this.
    const { fixture } = await setup({ name: 'lock', label: '' });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.getAttribute('role')).toBeNull();
    expect(host.getAttribute('aria-label')).toBeNull();
  });

  it('sizes the INNER element, which is the only place immune to the button utility', async () => {
    // The regression this pins: `HlmButton`'s cva carries
    // `[&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)]`. Before wrapping, an
    // oversized icon wrote `class="text-xl"` on the <ng-icon> itself and the `:not()`
    // excluded it. Wrapping moved that class to the HOST and left the inner element bare,
    // so the guard matched it and the utility overrode font-size — every one of those
    // buttons silently shrank 20px -> 16px.
    //
    // Asserted on `--ng-icon__size` rather than on a rendered dimension because that is the
    // property the fix turns on: it drives the inner element's own width/height instead of
    // its font-size, so no font-size utility can outrank it. jsdom does no layout, so a
    // size assertion is the strongest thing available here — the pixel result is checked in
    // a real browser instead.
    const { fixture } = await setup({ name: 'lock', size: 'lg' });
    const inner = (fixture.nativeElement as HTMLElement).querySelector(
      'ng-icon',
    ) as HTMLElement;

    expect(inner.style.getPropertyValue('--ng-icon__size')).toBe('1.25rem');
  });

  it('publishes canonical size and semantic ink without exposing vendor names', async () => {
    const { fixture } = await setup({
      name: 'lock',
      size: 'lg',
      variant: 'danger',
    });
    const host = fixture.nativeElement as HTMLElement;
    const inner = host.querySelector('ng-icon') as HTMLElement;

    expect(host.getAttribute('data-size')).toBe('lg');
    expect(host.getAttribute('data-variant')).toBe('danger');
    expect(inner.style.getPropertyValue('--ng-icon__size')).toBe('1.25rem');
  });

  it('leaves the size property off entirely when unset, so 1em still applies', async () => {
    // The ~100 icons that correctly inherit their size from the button utility must not
    // change. The input defaults to '', which the vendor's coercion returns untouched and
    // Angular then drops — binding a literal '0' or 'auto' here would resize all of them.
    const { fixture } = await setup({ name: 'lock' });
    const inner = (fixture.nativeElement as HTMLElement).querySelector(
      'ng-icon',
    ) as HTMLElement;

    expect(inner.style.getPropertyValue('--ng-icon__size')).toBe('');
  });

  it('keeps appearance off the host class contract', async () => {
    // The layered stylesheet now owns the inline-flex box. jsdom cannot evaluate @layer, so
    // real dimensions are asserted in Storybook. The unit-level contract is that variants
    // and sizes do not smuggle appearance classes onto the public host; a consumer class is
    // therefore reserved for external layout.
    const { fixture } = await setup({ name: 'lock' });
    const host = fixture.nativeElement as HTMLElement;

    expect([...host.classList]).toEqual([]);
  });

  it('is motionless by default, without leaving an activation hook behind', async () => {
    const { fixture } = await setup({ name: 'lock' });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.getAttribute('data-motion')).toBeNull();
  });

  it.each(TRN_ICON_MOTIONS)(
    'publishes the opt-in %s motion for the interactive ancestor',
    async (motion) => {
      const { fixture } = await setup({ name: 'lock', motion });
      const host = fixture.nativeElement as HTMLElement;

      expect(host.getAttribute('data-motion')).toBe(motion);
    },
  );
});
