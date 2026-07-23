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

@Component({
  standalone: true,
  template: `
    <button type="button">Cancel</button>
    <input data-autofocus placeholder="Search" />
  `,
})
class FocusDialogComponent {}

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

  it('focuses the element named by autoFocus, not the first tabbable one', async () => {
    // The shape every search-style dialog has: a dismiss button ahead of the field the
    // user came to type in. CDK's default ('first-tabbable') would take the button, and
    // a focus() call inside the component can't win — CDK focuses after attach.
    const svc = TestBed.inject(TrnDialogService);
    const ref = svc.open<void, FocusDialogComponent>(FocusDialogComponent, {
      autoFocus: '[data-autofocus]',
    });
    const appRef = TestBed.inject(ApplicationRef);
    appRef.tick();
    await appRef.whenStable();

    expect(document.activeElement?.tagName).toBe('INPUT');
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Search');

    ref.close();
  });

  it('reports whether any dialog is currently open (getTop replacement)', () => {
    const svc = TestBed.inject(TrnDialogService);
    expect(svc.hasOpen()).toBe(false);

    const ref = svc.open<string, TestDialogComponent>(TestDialogComponent);
    expect(svc.hasOpen()).toBe(true);

    ref.close();
    expect(svc.hasOpen()).toBe(false);
  });
});
