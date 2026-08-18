import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnTextarea } from './trn-textarea';

@Component({
  imports: [TrnTextarea],
  template: `<textarea
    trnTextarea
    rows="1"
    aria-describedby="hint"
  ></textarea>`,
})
class HostComponent {}

describe('TrnTextarea', () => {
  it('stays a native textarea, with its attributes intact', async () => {
    // One of the two call sites reads this element from TypeScript through a template ref as
    // a real HTMLTextAreaElement, and binds eight event handlers to it. An element wrapper
    // would hand that call site a component instance instead.
    const { container } = await render(HostComponent);
    const el = container.querySelector('textarea');

    expect(el?.tagName).toBe('TEXTAREA');
    expect(el?.rows).toBe(1);
    // The defect control: `data-slot` arrives only through the composed kit directive.
    expect(el?.getAttribute('data-slot')).toBe('textarea');
  });

  it('keeps a consumer’s aria-describedby, as the input wrapper does', async () => {
    const { container } = await render(HostComponent);

    expect(
      container.querySelector('textarea')?.getAttribute('aria-describedby'),
    ).toBe('hint');
  });
});
