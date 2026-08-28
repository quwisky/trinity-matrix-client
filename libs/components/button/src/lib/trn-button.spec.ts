import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { HlmButton } from '@trinity/helm/button';
import { describe, expect, it } from 'vitest';
import { TrnButton, TrnIconButton } from './trn-button';

@Component({
  imports: [TrnButton, TrnIconButton],
  template: `<button trnBtn variant="destructive" size="sm" disabled>
    Erase
  </button>`,
})
class HostComponent {}

@Component({
  imports: [TrnButton, TrnIconButton],
  template: `
    @for (size of iconSizes; track size) {
      <button trnBtn [size]="size">Icon</button>
    }
    <button trnBtn size="default">Label</button>
    <button data-testid="dynamic" trnBtn [size]="dynamicSize()">Dynamic</button>
    <a data-testid="icon-link" trnBtn size="icon" href="#target">Link</a>
    <button data-testid="bespoke" trnIconButton>Bespoke</button>
  `,
})
class IconHostComponent {
  readonly iconSizes = ['icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const;
  readonly dynamicSize = signal<'default' | 'icon'>('default');
}

describe('TrnButton', () => {
  it('forwards the supported button contract to the vendored treatment', async () => {
    const { container, fixture } = await render(HostComponent);
    const button = container.querySelector('button');
    const helm = fixture.debugElement
      .query(By.directive(HlmButton))
      .injector.get(HlmButton);

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('data-slot')).toBe('button');
    expect(helm.variant()).toBe('destructive');
    expect(helm.size()).toBe('sm');
  });

  it('marks every icon size without marking labelled sizes', async () => {
    const { container, fixture } = await render(IconHostComponent);
    const buttons = [...container.querySelectorAll('button')];

    expect(
      buttons
        .slice(0, 4)
        .every((button) => button.hasAttribute('data-trn-icon-button')),
    ).toBe(true);
    expect(buttons[4].hasAttribute('data-trn-icon-button')).toBe(false);
    expect(buttons[5].hasAttribute('data-trn-icon-button')).toBe(false);
    expect(
      container
        .querySelector('[data-testid="icon-link"]')
        ?.hasAttribute('data-trn-icon-button'),
    ).toBe(true);
    expect(
      fixture.debugElement.queryAll(By.directive(TrnIconButton)),
    ).toHaveLength(1);
    expect(
      container
        .querySelector('[data-testid="bespoke"]')
        ?.hasAttribute('data-trn-icon-button'),
    ).toBe(true);
  });

  it('updates the marker when a bound size changes', async () => {
    const { container, fixture } = await render(IconHostComponent);
    const host = fixture.componentInstance;
    const dynamic = container.querySelector('[data-testid="dynamic"]')!;

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(false);

    host.dynamicSize.set('icon');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(true);
  });
});
