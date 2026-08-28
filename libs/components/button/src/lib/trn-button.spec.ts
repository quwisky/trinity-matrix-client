import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { HlmButton } from '@trinity/helm/button';
import { describe, expect, it } from 'vitest';
import { TrnButton } from './trn-button';

@Component({
  imports: [TrnButton],
  template: `<button trnBtn variant="destructive" size="sm" disabled>
    Erase
  </button>`,
})
class HostComponent {}

@Component({
  imports: [TrnButton],
  template: `
    @for (size of iconSizes; track size) {
      <button trnBtn [size]="size">Icon</button>
    }
    <button trnBtn size="default">Label</button>
    <button trnBtn [size]="dynamicSize()">Dynamic</button>
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
    const { container } = await render(IconHostComponent);
    const buttons = [...container.querySelectorAll('button')];

    expect(
      buttons
        .slice(0, 4)
        .every((button) => button.hasAttribute('data-trn-icon-button')),
    ).toBe(true);
    expect(buttons[4].hasAttribute('data-trn-icon-button')).toBe(false);
    expect(buttons[5].hasAttribute('data-trn-icon-button')).toBe(false);
  });

  it('updates the marker when a bound size changes', async () => {
    const { container, fixture } = await render(IconHostComponent);
    const host = fixture.componentInstance;
    const dynamic = container.querySelectorAll('button')[5];

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(false);

    host.dynamicSize.set('icon');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(dynamic.hasAttribute('data-trn-icon-button')).toBe(true);
  });
});
