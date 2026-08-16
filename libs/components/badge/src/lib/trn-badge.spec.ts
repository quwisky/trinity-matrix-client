import { Component } from '@angular/core';
import { badgeVariants } from '@trinity/helm/badge';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnBadge, type TrnBadgeVariant } from './trn-badge';

@Component({
  imports: [TrnBadge],
  template: `<span trnBadge variant="success">Verified</span>`,
})
class HostComponent {}

describe('TrnBadge', () => {
  it('reflects our variant onto the host', async () => {
    // The defect control: `data-variant` is written by THIS directive, so removing it from
    // the template leaves the attribute absent.
    const { container } = await render(HostComponent);
    const badge = container.querySelector('span');

    expect(badge?.tagName).toBe('SPAN');
    expect(badge?.getAttribute('data-variant')).toBe('success');
  });

  it('maps every variant we publish onto one the kit actually has', () => {
    // Asserted on the pure cva function rather than the applied class string, which is
    // applied asynchronously and is explicitly not safe to assert (see ui-and-theming.md).
    // What this catches is the real drift risk: an upstream rename would make one of our
    // variants fall through to `defaultVariants` and render as `default`, silently.
    const ours: TrnBadgeVariant[] = ['default', 'success', 'warning'];
    const rendered = ours.map((variant) => badgeVariants({ variant }));

    expect(new Set(rendered).size).toBe(ours.length);
  });
});
