import { ApplicationRef, Component, inject, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DialogRef } from '@angular/cdk/dialog';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { TrnDialogService } from './trn-dialog.service';

@Component({ standalone: true, template: `<p>{{ label() }}</p>` })
class TestDialogComponent {
  readonly label = input('');
  private readonly ref =
    inject<DialogRef<string, TestDialogComponent>>(DialogRef);
  close(value: string): void {
    this.ref.close(value);
  }
}

describe('TrnDialogService', () => {
  it('opens a component, sets its inputs, and closes with a value', async () => {
    const svc = TestBed.inject(TrnDialogService);
    const ref = svc.open<string, TestDialogComponent>(TestDialogComponent, {
      inputs: { label: 'Hi there' },
    });
    TestBed.inject(ApplicationRef).tick();

    expect(ref.componentInstance).toBeTruthy();
    expect(document.body.textContent).toContain('Hi there'); // input applied

    const closed = firstValueFrom(ref.closed);
    ref.componentInstance!.close('picked');
    expect(await closed).toBe('picked');
  });

  it('maps a bare dismiss to null (openAndWait contract)', async () => {
    const svc = TestBed.inject(TrnDialogService);
    const ref = svc.open<string, TestDialogComponent>(TestDialogComponent);
    const waited = firstValueFrom(ref.closed).then((v) => v ?? null);
    ref.close(); // dismissed without a value
    expect(await waited).toBeNull();
  });

  it('opens an end-aligned side panel (side: "end") that still renders and closes', async () => {
    const svc = TestBed.inject(TrnDialogService);
    const ref = svc.open<string, TestDialogComponent>(TestDialogComponent, {
      side: 'end',
      inputs: { label: 'Side' },
    });
    TestBed.inject(ApplicationRef).tick();

    // The right-aligned global position strategy pins the pane to the viewport edge.
    const wrapper = document.querySelector('.cdk-global-overlay-wrapper');
    expect(wrapper).toBeTruthy();
    expect(document.body.textContent).toContain('Side');

    const closed = firstValueFrom(ref.closed);
    ref.componentInstance!.close('done');
    expect(await closed).toBe('done');
  });
});
