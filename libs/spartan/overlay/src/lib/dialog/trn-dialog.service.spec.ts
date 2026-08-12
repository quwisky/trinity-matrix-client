import { ApplicationRef, Component, inject, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { TrnAlertService } from '../alert/trn-alert.service';
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

  it('closes the top of the stack, not the bottom', async () => {
    const svc = TestBed.inject(TrnDialogService);
    const bottom = svc.open<string, TestDialogComponent>(TestDialogComponent, {
      inputs: { label: 'Bottom' },
    });
    const top = svc.open<string, TestDialogComponent>(TestDialogComponent, {
      inputs: { label: 'Top' },
    });
    TestBed.inject(ApplicationRef).tick();

    const topClosed = firstValueFrom(top.closed);
    expect(svc.closeTopmost()).toBe(true);
    await topClosed;

    // The assertion that matters for the back button: one press dismisses one
    // overlay. Closing the whole stack, or the wrong end of it, would both leave
    // `hasOpen()` looking plausible while the user lost work they could still see.
    expect(svc.hasOpen()).toBe(true);
    TestBed.inject(ApplicationRef).tick();
    expect(document.body.textContent).toContain('Bottom');
    expect(document.body.textContent).not.toContain('Top');

    bottom.close();
  });

  it('reports false when there is nothing to close, so back can fall through to navigation', () => {
    const svc = TestBed.inject(TrnDialogService);
    expect(svc.hasOpen()).toBe(false);
    expect(svc.closeTopmost()).toBe(false);
  });

  it('reports false when the overlay declines to close, rather than swallowing the press', () => {
    // CDK's `close()` consults `closePredicate` and can decline, leaving the dialog on
    // screen. A `closeTopmost()` that reported "I found one" as "I closed one" would make
    // the back button do nothing at all — no dismissal AND no navigation. Faked here
    // because nothing in the workspace sets a predicate today; the point is that the
    // contract holds the first time something does.
    const declining = { close: () => undefined } as unknown as DialogRef;
    TestBed.configureTestingModule({
      providers: [{ provide: Dialog, useValue: { openDialogs: [declining] } }],
    });
    const svc = TestBed.inject(TrnDialogService);

    expect(svc.hasOpen()).toBe(true);
    expect(svc.closeTopmost()).toBe(false);
  });

  it('also closes an alert, because the CDK dialog stack is shared', async () => {
    const svc = TestBed.inject(TrnDialogService);
    const alerts = TestBed.inject(TrnAlertService);

    // `Dialog` is providedIn: 'root', so TrnAlertService and TrnActionSheetService
    // push onto the same `openDialogs` this service reads. If closeTopmost() were
    // ever narrowed to "dialogs opened through open()", the Android back button
    // would silently stop dismissing alerts and action sheets — and every test that
    // only opened dialogs would still pass.
    // A dialog underneath, so this discriminates on both axes at once: an
    // implementation that tracked only its own refs would never resolve the alert,
    // and one that closed the whole stack would take the dialog with it.
    const beneath = svc.open<string, TestDialogComponent>(TestDialogComponent, {
      inputs: { label: 'Beneath' },
    });
    const confirmed = alerts.confirm({
      header: 'Delete this room?',
      confirmText: 'Delete',
    });
    TestBed.inject(ApplicationRef).tick();

    expect(svc.closeTopmost()).toBe(true);
    expect(await confirmed).toBe(false);

    expect(svc.hasOpen()).toBe(true);
    TestBed.inject(ApplicationRef).tick();
    expect(document.body.textContent).toContain('Beneath');

    beneath.close();
    expect(svc.hasOpen()).toBe(false);
  });

  it('closes every open overlay at once (teardown)', async () => {
    const svc = TestBed.inject(TrnDialogService);
    svc.open<string, TestDialogComponent>(TestDialogComponent);
    svc.open<string, TestDialogComponent>(TestDialogComponent);
    TestBed.inject(ApplicationRef).tick();
    expect(svc.hasOpen()).toBe(true);

    svc.closeAll();
    expect(svc.hasOpen()).toBe(false);
  });
});
