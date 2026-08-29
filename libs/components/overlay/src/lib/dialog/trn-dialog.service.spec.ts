import { ApplicationRef, Component, inject, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { firstValueFrom, NEVER } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrnAlertService } from '../alert/trn-alert.service';
import { TrnDialogRef } from './trn-dialog-ref';
import { TrnDialogService } from './trn-dialog.service';

// Closes ITSELF through the ref it injects, which is the path that matters: `TrnDialogRef`
// is Trinity's own class, provided into the dialog's injector by `open()`, and injecting it
// here is what proves that provider is wired. It is also why these tests click a button
// rather than reach for `componentInstance` — the wrapper deliberately does not expose the
// instance, since that member is CDK's and would put the vendor back in the signature.
@Component({
  standalone: true,
  template: `<p>{{ label() }}</p>
    <button type="button" data-testid="close" (click)="close(label())">
      Close
    </button>`,
})
class TestDialogComponent {
  readonly label = input('');
  private readonly ref = inject<TrnDialogRef<string>>(TrnDialogRef);
  close(value: string): void {
    this.ref.close(value);
  }
}

/** Click the open test dialog's own close button, so it closes with its label. */
const clickClose = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="close"]')?.click();

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

    expect(document.body.textContent).toContain('Hi there'); // input applied

    const closed = firstValueFrom(ref.closed);
    clickClose();
    expect(await closed).toBe('Hi there');
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
    clickClose();
    expect(await closed).toBe('Side');
  });

  it('gives a full-screen dialog the complete viewport pane', () => {
    const svc = TestBed.inject(TrnDialogService);
    const ref = svc.open(TestDialogComponent, { side: 'full-screen' });
    TestBed.inject(ApplicationRef).tick();

    const pane = document.querySelector<HTMLElement>('.cdk-overlay-pane');
    expect(pane?.style.width).toBe('100vw');
    expect(pane?.style.height).toBe('100dvh');
    expect(pane?.style.maxWidth).toBe('100vw');
    expect(pane?.style.maxHeight).toBe('100dvh');

    ref.close();
  });

  it('opens a content dialog as a bottom sheet with bounded mobile geometry', () => {
    const svc = TestBed.inject(TrnDialogService);
    const ref = svc.open(TestDialogComponent, { side: 'bottom' });
    TestBed.inject(ApplicationRef).tick();

    const pane = document.querySelector<HTMLElement>('.cdk-overlay-pane');
    expect(pane?.style.width).toBe('min(100vw, 36rem)');
    expect(pane?.style.maxWidth).toBe('100vw');
    expect(pane?.style.maxHeight).toBe('calc(100dvh - 12px)');
    expect(document.querySelector('.cdk-global-overlay-wrapper')).toBeTruthy();

    ref.close();
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
    expect(svc.openState()).toBe(false);

    const ref = svc.open<string, TestDialogComponent>(TestDialogComponent);
    expect(svc.hasOpen()).toBe(true);
    expect(svc.openState()).toBe(true);

    ref.close();
    expect(svc.hasOpen()).toBe(false);
    expect(svc.openState()).toBe(false);
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
    expect(svc.openState()).toBe(true);
    TestBed.inject(ApplicationRef).tick();
    expect(document.body.textContent).toContain('Bottom');
    expect(document.body.textContent).not.toContain('Top');

    bottom.close();
    expect(svc.openState()).toBe(false);
  });

  it('reports false when there is nothing to close, so back can fall through to navigation', () => {
    const svc = TestBed.inject(TrnDialogService);
    expect(svc.hasOpen()).toBe(false);
    expect(svc.closeTopmost()).toBe(false);
  });

  it('reports false when the overlay declines to close', () => {
    // CDK's `close()` consults `closePredicate` and can decline, leaving the dialog on
    // screen. The return value means "did one close", not "was one there" — reporting a
    // refusal as success would tell a caller the screen changed when it did not. What the
    // back button then does with an overlay that refused is the SHELL's decision, and it
    // swallows the press rather than navigating under it; see app.component.spec.ts.
    // Faked here because nothing in the workspace sets a predicate today; the point is
    // that the contract holds the first time something does.
    const declining = { close: () => undefined } as unknown as DialogRef;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Dialog,
          useValue: {
            openDialogs: [declining],
            afterOpened: NEVER,
            afterAllClosed: NEVER,
          },
        },
      ],
    });
    const svc = TestBed.inject(TrnDialogService);

    expect(svc.hasOpen()).toBe(true);
    expect(svc.openState()).toBe(true);
    expect(svc.closeTopmost()).toBe(false);
  });

  it('leaves a disableClose dialog alone, which CDK would not', async () => {
    // The flag exists so a flow-critical dialog cannot be dismissed out from under
    // itself — encryption-unlock and device-verification both set it. CDK enforces it
    // only for the backdrop and Escape: `DialogRef.close()` gates on `closePredicate`
    // and never looks at `disableClose`, so the programmatic close behind the Android
    // back button walked straight through it. Driven against the REAL CDK stack rather
    // than a stub, because a stub would assert our own belief about CDK back to us —
    // and that belief is precisely what was wrong.
    const svc = TestBed.inject(TrnDialogService);
    const locked = svc.open<string, TestDialogComponent>(TestDialogComponent, {
      inputs: { label: 'Locked' },
      disableClose: true,
    });
    TestBed.inject(ApplicationRef).tick();

    expect(svc.closeTopmost()).toBe(false);
    expect(svc.hasOpen()).toBe(true);
    TestBed.inject(ApplicationRef).tick();
    expect(document.body.textContent).toContain('Locked');

    // Still closable by the code that owns the flow — the guard is about who decides,
    // not about making the dialog permanent.
    locked.close();
    TestBed.inject(ApplicationRef).tick();
    expect(svc.hasOpen()).toBe(false);
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
    expect(svc.openState()).toBe(true);
    TestBed.inject(ApplicationRef).tick();
    expect(document.body.textContent).toContain('Beneath');

    beneath.close();
    expect(svc.hasOpen()).toBe(false);
    expect(svc.openState()).toBe(false);
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

describe('TrnDialogService — anchored presentation', () => {
  /** A real, laid-out element to hang the popover off. */
  function anchorElement(): HTMLElement {
    const anchor = document.createElement('a');
    anchor.textContent = '@bob';
    document.body.append(anchor);
    return anchor;
  }

  afterEach(() => {
    document
      .querySelectorAll('.cdk-overlay-container, body > a')
      .forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  it('positions against the anchor instead of centring', () => {
    const svc = TestBed.inject(TrnDialogService);

    svc.open(TestDialogComponent, { anchor: anchorElement() });
    TestBed.inject(ApplicationRef).tick();

    // CDK wraps a flexible connected overlay in this box and nothing else does, so its
    // presence is what distinguishes an anchored panel from the global centred strategy.
    expect(
      document.querySelector('.cdk-overlay-connected-position-bounding-box'),
    ).not.toBeNull();
  });

  it('drops the scrim for an anchored panel', () => {
    // A dark backdrop over the thing the popover is ABOUT defeats the point of anchoring
    // it. The backdrop stays — an outside click still closes — it just stops dimming.
    const svc = TestBed.inject(TrnDialogService);

    svc.open(TestDialogComponent, { anchor: anchorElement() });
    TestBed.inject(ApplicationRef).tick();

    expect(
      document.querySelector('.cdk-overlay-transparent-backdrop'),
    ).not.toBeNull();
    expect(document.querySelector('.cdk-overlay-dark-backdrop')).toBeNull();
  });

  it('keeps the centred modal on a touch pointer', () => {
    // A card pinned to a mention halfway down a phone screen has nowhere to go and lands
    // under a thumb. Coarse pointers ignore the anchor entirely.
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(pointer: coarse)',
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const svc = TestBed.inject(TrnDialogService);

    svc.open(TestDialogComponent, { anchor: anchorElement() });
    TestBed.inject(ApplicationRef).tick();

    expect(
      document.querySelector('.cdk-overlay-connected-position-bounding-box'),
    ).toBeNull();
    expect(document.querySelector('.cdk-overlay-dark-backdrop')).not.toBeNull();
  });

  it('still centres when no anchor is given', () => {
    const svc = TestBed.inject(TrnDialogService);

    svc.open(TestDialogComponent);
    TestBed.inject(ApplicationRef).tick();

    expect(
      document.querySelector('.cdk-overlay-connected-position-bounding-box'),
    ).toBeNull();
    expect(document.querySelector('.cdk-overlay-dark-backdrop')).not.toBeNull();
  });
});
