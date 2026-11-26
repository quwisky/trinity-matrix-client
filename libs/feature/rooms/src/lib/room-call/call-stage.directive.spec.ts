import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CallStageService } from '@trinity/data-access/calls';
import { render } from '@trinity/testing';
import { describe, expect, it } from 'vitest';
import { CallStageDirective } from './call-stage.directive';

@Component({
  imports: [CallStageDirective],
  template: `@if (shown()) {
    <div trnCallStage data-testid="stage"></div>
  }`,
})
class HostComponent {
  readonly shown = signal(true);
}

describe('CallStageDirective', () => {
  it('offers its element as the call stage while rendered', async () => {
    const { fixture, getByTestId } = await render(HostComponent);
    const stage = TestBed.inject(CallStageService);
    expect(stage.element()).toBe(getByTestId('stage'));

    fixture.componentInstance.shown.set(false);
    fixture.detectChanges();
    expect(stage.element()).toBeNull();
  });
});
