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
  variant: 'neutral' | 'accent' | 'page' | 'chat' = 'page';
  layout: TrnPageHeaderLayout = 'page';
  title: string | undefined = 'Settings';
}

@Component({
  imports: [PageHeaderComponent],
  template: `
    <trn-page-header variant="chat">
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

  it('keeps legacy layouts equivalent to canonical inputs', async () => {
    const { fixture, container } = await render(PageHeaderComponent, {
      inputs: { title: 'X', variant: 'page' },
    });
    const header = () => container.querySelector('header')!;

    expect(header().className).toContain('safe-top');
    expect(header().className).toContain('min-h-14');
    expect(header().getAttribute('data-trn-layout')).toBe('page');
    const legacyPageClass = header().className;

    fixture.componentRef.setInput('variant', 'neutral');
    fixture.componentRef.setInput('layout', 'page');
    await fixture.whenStable();
    expect(header().className).toBe(legacyPageClass);

    fixture.componentRef.setInput('variant', 'chat');
    await fixture.whenStable();
    const legacyToolbarClass = header().className;
    expect(header().className).toContain(
      'bg-[var(--trinity-surface-workspace)]',
    );
    expect(header().className).not.toContain('safe-top');
    expect(header().className).not.toContain('min-h-14');
    expect(header().getAttribute('data-trn-layout')).toBe('toolbar');

    fixture.componentRef.setInput('variant', 'neutral');
    fixture.componentRef.setInput('layout', 'toolbar');
    await fixture.whenStable();
    expect(header().className).toBe(legacyToolbarClass);
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
    expect(header.className).toContain('safe-top');
  });

  it('does not reflect the title input onto a native title attribute (no whole-bar tooltip)', async () => {
    const { container } = await render(TitleHostComponent);
    const host = container.querySelector('trn-page-header')!;
    expect(host.getAttribute('title')).toBeNull();
    expect(container.querySelector('header')!.getAttribute('title')).toBeNull();
  });
});
