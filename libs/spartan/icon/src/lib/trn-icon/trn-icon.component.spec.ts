import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
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

  it('renders at the inherited font-size by default', async () => {
    const { fixture } = await setup({ name: 'lock' });
    const icon = (fixture.nativeElement as HTMLElement).querySelector(
      'ng-icon',
    ) as HTMLElement;

    // `md` must be 1em, not a pixel value: ng-icon's own default inherits font-size, and
    // ~90 icons in the app take their size from an ancestor. A px default resizes them all.
    expect(icon.style.getPropertyValue('--ng-icon__size')).toBe('1em');
  });

  it('maps the size tokens to lengths', async () => {
    const { fixture } = await setup({ name: 'lock', size: 'xl' });
    const icon = (fixture.nativeElement as HTMLElement).querySelector(
      'ng-icon',
    ) as HTMLElement;

    expect(icon.style.getPropertyValue('--ng-icon__size')).toBe('1.25rem');
  });
});
