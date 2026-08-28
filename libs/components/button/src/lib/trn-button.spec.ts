import { Component } from '@angular/core';
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
});
