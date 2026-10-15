import { Component, signal } from '@angular/core';
import { InputModalityDetector } from '@angular/cdk/a11y';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lastInputTarget,
  releaseInputTargetOnDestroy,
} from './release-input-target';

@Component({
  selector: 'trn-test-panel',
  template: `<button type="button">Close</button>`,
})
class PanelComponent {
  constructor() {
    releaseInputTargetOnDestroy();
  }
}

@Component({
  imports: [PanelComponent],
  template: `<button type="button" class="outside">Elsewhere</button>
    @if (open()) {
      <trn-test-panel />
    }`,
})
class HostComponent {
  readonly open = signal(true);
}

function press(target: Element): void {
  target.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 1 }),
  );
}

describe('releaseInputTargetOnDestroy', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function render() {
    const fixture = TestBed.createComponent(HostComponent);
    document.body.append(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
    const detector = TestBed.inject(InputModalityDetector);
    const query = (selector: string) =>
      (fixture.nativeElement as HTMLElement).querySelector(
        selector,
      ) as HTMLElement;
    return { fixture, detector, query };
  }

  // Guards the CDK internals the helper relies on: the detector keeps the last pressed element
  // in `_mostRecentTarget` and nothing clears it until the next press or key. If this fails
  // after a CDK update, revisit release-input-target.ts.
  it('relies on the CDK detector keeping the last pressed element', () => {
    const { detector, query } = render();
    const close = query('trn-test-panel button');

    press(close);

    expect(detector._mostRecentTarget).toBe(close);
  });

  it('lets go of a pressed element inside the component when it goes', () => {
    const { fixture, detector, query } = render();
    press(query('trn-test-panel button'));

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    expect(detector._mostRecentTarget).toBeNull();
  });

  // Feature specs may not reach the CDK, so they read the detector through this.
  it('reads the element the detector last recorded', () => {
    const { fixture, query } = render();
    const close = query('trn-test-panel button');
    const last = () => TestBed.runInInjectionContext(lastInputTarget);

    press(close);
    expect(last()).toBe(close);

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    expect(last()).toBeNull();
  });

  it('leaves a pressed element outside the component alone', () => {
    const { fixture, detector, query } = render();
    const outside = query('.outside');
    press(outside);

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    expect(detector._mostRecentTarget).toBe(outside);
  });
});
