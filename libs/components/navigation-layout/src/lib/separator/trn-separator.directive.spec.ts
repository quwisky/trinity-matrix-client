import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnSeparatorDirective } from './trn-separator.directive';

@Component({
  imports: [TrnSeparatorDirective],
  template: `
    <div
      trnSeparator
      data-t="announced"
      orientation="vertical"
      [decorative]="false"
    ></div>
    <div trnSeparator data-t="default"></div>
  `,
})
class HostComponent {}

describe('TrnSeparatorDirective', () => {
  it('announces itself when the caller says it means something', async () => {
    // The bindings reach BrnSeparator through TWO layers of hostDirectives, which is the
    // thing worth pinning here: neither is re-published by name, so a wrong list would leave
    // both silently inert rather than failing to compile.
    const { container } = await render(HostComponent);

    const rule = container.querySelector('[data-t="announced"]')!;
    expect(rule.getAttribute('role')).toBe('separator');
    expect(rule.getAttribute('data-orientation')).toBe('vertical');
  });

  it('is decoration by default, as upstream has it', async () => {
    // Not inverted locally: a regenerate would put it back and every call site would quietly
    // change meaning. A caller who wants the rule heard asks for it.
    const { container } = await render(HostComponent);

    const rule = container.querySelector('[data-t="default"]')!;
    expect(rule.getAttribute('role')).toBe('none');
  });
});
