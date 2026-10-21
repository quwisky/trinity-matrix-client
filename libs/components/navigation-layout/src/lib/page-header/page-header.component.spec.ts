import { Component } from '@angular/core';
import { render } from '@trinity/testing';
import { expectTypeOf } from 'vitest';
import { PageHeaderComponent } from './page-header.component';
import type {
  TrnPageHeaderLayout,
  TrnPageHeaderVariant,
} from './trn-page-header-recipe';

@Component({
  imports: [PageHeaderComponent],
  template: `
    <trn-page-header [variant]="variant" [layout]="layout" [title]="title">
      <button trnHeaderLeading class="lead">Back</button>
      <span trnHeaderActions><button class="act">Close</button></span>
    </trn-page-header>
  `,
})
class TitleHostComponent {
  variant: TrnPageHeaderVariant = 'neutral';
  layout: TrnPageHeaderLayout = 'page';
  title: string | undefined = 'Settings';
}

@Component({
  imports: [PageHeaderComponent],
  template: `
    <trn-page-header layout="toolbar">
      <span trnHeaderTitle class="projected-title"># general</span>
    </trn-page-header>
  `,
})
class ProjectedTitleHostComponent {}

describe('PageHeaderComponent', () => {
  it('separates semantic treatment from layout', () => {
    expectTypeOf<TrnPageHeaderVariant>().toEqualTypeOf<'neutral' | 'accent'>();
    expectTypeOf<TrnPageHeaderLayout>().toEqualTypeOf<'page' | 'toolbar'>();
  });

  it('renders exactly one header and one h1, with the title input as the heading text', async () => {
    const { container } = await render(TitleHostComponent);

    expect(container.querySelectorAll('header')).toHaveLength(1);
    const headings = container.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent?.trim()).toBe('Settings');
  });

  it('projects the leading and actions slots', async () => {
    const { container } = await render(TitleHostComponent);

    expect(container.querySelector('.lead')?.textContent?.trim()).toBe('Back');
    expect(container.querySelector('.act')?.textContent?.trim()).toBe('Close');
  });

  it('falls back to the projected [trnHeaderTitle] inside the h1 when no title input is set', async () => {
    const { container } = await render(ProjectedTitleHostComponent);

    const h1 = container.querySelector('h1');
    expect(h1).toBeTruthy();
    // The projected title is the body of the single h1 — not a nested heading.
    expect(h1?.querySelector('.projected-title')?.textContent?.trim()).toBe(
      '# general',
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('applies canonical page and toolbar layouts', async () => {
    const { fixture, container } = await render(PageHeaderComponent, {
      inputs: { title: 'X', variant: 'neutral', layout: 'page' },
    });
    const header = () => container.querySelector('header')!;

    // The application frame owns the top safe-area inset; a routed header must not add it again.
    expect(header().className).not.toContain('safe-top');
    expect(header().className).toContain('min-h-14');
    expect(header().className).toContain('border-border');
    expect(header().className).not.toContain(
      'bg-[var(--trinity-surface-workspace)]',
    );
    expect(header().className).not.toContain(
      'text-[var(--trinity-text-bright)]',
    );
    expect(header().getAttribute('data-trn-layout')).toBe('page');
    fixture.componentRef.setInput('layout', 'toolbar');
    await fixture.whenStable();
    expect(header().className).toContain(
      'bg-[var(--trinity-surface-workspace)]',
    );
    expect(header().className).not.toContain('safe-top');
    expect(header().className).not.toContain('min-h-14');
    expect(header().className).toContain('text-[var(--trinity-text-bright)]');
    expect(header().getAttribute('data-trn-layout')).toBe('toolbar');
  });

  it('applies accent without changing page geometry', async () => {
    const { container } = await render(PageHeaderComponent, {
      inputs: { title: 'Attention', variant: 'accent', layout: 'page' },
    });
    const header = container.querySelector('header')!;

    expect(header.getAttribute('data-trn-variant')).toBe('accent');
    expect(header.getAttribute('data-trn-layout')).toBe('page');
    expect(header.className).toContain(
      'bg-[var(--trinity-state-attention-surface)]',
    );
    expect(header.className).not.toContain('safe-top');
  });

  it('declares the attention surface for its actions only in the accent variant', async () => {
    const { fixture, container } = await render(PageHeaderComponent, {
      inputs: { title: 'Attention', variant: 'neutral', layout: 'page' },
    });
    const header = () => container.querySelector('header')!;
    // Neutral paints no attention surface; a solid button keeps its accent fill there.
    expect(header().hasAttribute('data-trn-surface')).toBe(false);

    // Accent paints the attention surface, the same colour as a solid primary fill, so it
    // tells trnBtn to use the on-attention action roles instead (#1224).
    fixture.componentRef.setInput('variant', 'accent');
    await fixture.whenStable();
    expect(header().getAttribute('data-trn-surface')).toBe('attention');
    // Every focusable in the header sits on the accent, so it gets the on-attention ring.
    expect(header().className).toContain(
      '[--trinity-focus-ring:var(--trinity-focus-ring-on-attention)]',
    );

    // The accent fill outranks the toolbar's workspace background, so the toolbar layout
    // paints the attention surface too and needs the same opt-in.
    fixture.componentRef.setInput('layout', 'toolbar');
    await fixture.whenStable();
    expect(header().className).toContain(
      'bg-[var(--trinity-state-attention-surface)]',
    );
    expect(header().className).not.toContain(
      'bg-[var(--trinity-surface-workspace)]',
    );
    expect(header().getAttribute('data-trn-surface')).toBe('attention');
    expect(header().className).toContain(
      '[--trinity-focus-ring:var(--trinity-focus-ring-on-attention)]',
    );

    // Back to neutral, the header stops declaring the attention context and its ring.
    fixture.componentRef.setInput('variant', 'neutral');
    await fixture.whenStable();
    expect(header().hasAttribute('data-trn-surface')).toBe(false);
    expect(header().className).not.toContain('focus-ring-on-attention');
  });

  it('does not reflect the title input onto a native title attribute (no whole-bar tooltip)', async () => {
    const { container } = await render(TitleHostComponent);
    const host = container.querySelector('trn-page-header')!;
    expect(host.getAttribute('title')).toBeNull();
    expect(container.querySelector('header')!.getAttribute('title')).toBeNull();
  });
});
