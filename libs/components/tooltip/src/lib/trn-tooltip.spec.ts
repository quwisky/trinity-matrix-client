import { Component } from '@angular/core';
import { By } from '@angular/platform-browser';
import { BrnTooltip } from '@spartan-ng/brain/tooltip';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnTooltip } from './trn-tooltip';

@Component({
  imports: [TrnTooltip],
  template: `<button trnTooltip="Members" aria-label="Members">M</button>`,
})
class HostComponent {}

describe('TrnTooltip', () => {
  it('publishes the message under our own name', async () => {
    // The defect control, and the reason this wrapper composes brain directly instead of the
    // kit directive: the message is published by the kit as `hlmTooltip`, and re-aliasing it
    // one level up throws NG0311. Reading it off the composed BrnTooltip proves the rename
    // actually took — a template that still said `hlmTooltip` would leave this undefined.
    const { fixture } = await render(HostComponent);
    // `.injector.get`, not `.componentInstance`: on a debug element the latter is the
    // COMPONENT that owns the element, not the directive applied to it.
    const brn = fixture.debugElement
      .query(By.directive(BrnTooltip))
      .injector.get(BrnTooltip);

    expect(brn.brnTooltip()).toBe('Members');
  });

  it('decorates the host without replacing it', async () => {
    // 29 of 30 call sites put this on a button that already carries other directives, and
    // one puts it on a <trn-icon>. Anything that changed the host element would break both.
    const { container } = await render(HostComponent);
    const button = container.querySelector('button');

    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-label')).toBe('Members');
  });
});
