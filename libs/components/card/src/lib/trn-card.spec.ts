import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { TrnCardImports } from './trn-card';

@Component({
  imports: [TrnCardImports],
  template: `
    <section trnCard>
      <div trnCardHeader>
        <h2 trnCardTitle>Sign in</h2>
        <p trnCardDescription>Pick a homeserver</p>
      </div>
      <div trnCardContent>body</div>
    </section>
  `,
})
class HostComponent {}

describe('TrnCard', () => {
  it('keeps the call site’s semantics and composes each kit slot', async () => {
    const { container } = await render(HostComponent);

    // The reason these are attributes: the call site chose section/h2/p, and the document
    // outline depends on keeping them. An element wrapper would have replaced all three.
    expect(container.querySelector('section')?.getAttribute('data-slot')).toBe(
      'card',
    );
    expect(container.querySelector('h2')?.getAttribute('data-slot')).toBe(
      'card-title',
    );
    expect(container.querySelector('p')?.getAttribute('data-slot')).toBe(
      'card-description',
    );
    // The defect control: `data-slot` arrives only through the composed kit directives.
    expect(
      container.querySelector('div[trnCardContent]')?.getAttribute('data-slot'),
    ).toBe('card-content');
  });
});
