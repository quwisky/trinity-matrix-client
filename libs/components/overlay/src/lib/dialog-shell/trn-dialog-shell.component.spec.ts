import { Component, type Provider } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import { fireEvent, render, screen } from '@trinity/testing';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  TrnDialogRef,
  type TrnDialogPresentation,
} from '../dialog/trn-dialog-ref';
import {
  TrnDialogActions,
  TrnDialogShellComponent,
} from './trn-dialog-shell.component';

@Component({
  imports: [TrnDialogShellComponent, TrnDialogActions],
  template: `
    <trn-dialog-shell title="Leave room?" description="You can rejoin later.">
      <p>Body</p>
      <div trnDialogActions><button>Cancel</button><button>Leave</button></div>
    </trn-dialog-shell>
  `,
})
class ActionsHostComponent {}

@Component({
  imports: [TrnDialogShellComponent],
  template: `<trn-dialog-shell title="Info"><p>Body</p></trn-dialog-shell>`,
})
class PlainHostComponent {}

@Component({
  imports: [TrnDialogShellComponent],
  template: `<trn-dialog-shell title="Switch room" [titleHidden]="true" />`,
})
class HiddenTitleHostComponent {}

@Component({
  imports: [TrnDialogShellComponent],
  template: `<trn-dialog-shell
    title="Switch room"
    [titleHidden]="true"
    [closable]="false"
  />`,
})
class BareHostComponent {}

@Component({
  imports: [TrnDialogShellComponent],
  template: `<trn-dialog-shell title="Busy" [closable]="false" />`,
})
class NotClosableHostComponent {}

@Component({
  imports: [TrnDialogShellComponent],
  template: `<trn-dialog-shell title="Edit" (closed)="onClosed()" />`,
})
class HandledCloseHostComponent {
  readonly onClosed = vi.fn();
}

function refFor(presentation: TrnDialogPresentation): {
  close: ReturnType<typeof vi.fn>;
  providers: Provider[];
} {
  const close = vi.fn();
  const ref = new TrnDialogRef({ closed: new Subject(), close }, presentation);
  return {
    close,
    providers: [provideTrnIcons(), { provide: TrnDialogRef, useValue: ref }],
  };
}

const surface = () => screen.getByTestId('dialog-surface');

describe('TrnDialogShellComponent', () => {
  it('renders title, body and a footer band with the projected actions', async () => {
    await render(ActionsHostComponent, { providers: [provideTrnIcons()] });

    expect(
      screen.getByRole('heading', { level: 2, name: 'Leave room?' }),
    ).toBeTruthy();
    // In the scrolling body, so a long description cannot push the footer off a sheet.
    expect(
      screen.getByText('You can rejoin later.').closest('.dialog-shell__body'),
    ).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
    expect(screen.getByTestId('dialog-footer').textContent).toContain('Leave');
  });

  it('omits the footer band when there are no actions', async () => {
    await render(PlainHostComponent, { providers: [provideTrnIcons()] });

    expect(screen.getByText('Body')).toBeTruthy();
    expect(screen.queryByTestId('dialog-footer')).toBeNull();
  });

  it('titles the dialog through the id its ref carries, also when visually hidden', async () => {
    const ref = new TrnDialogRef(
      { closed: new Subject(), close: vi.fn() },
      'dialog',
      'opened-dialog-title',
    );
    await render(HiddenTitleHostComponent, {
      providers: [provideTrnIcons(), { provide: TrnDialogRef, useValue: ref }],
    });

    // The opener's CDK container is the one dialog role; it points at this heading.
    const heading = screen.getByRole('heading', {
      level: 2,
      name: 'Switch room',
    });
    expect(heading.id).toBe('opened-dialog-title');
    expect(heading.classList).toContain('sr-only');
    expect(surface().hasAttribute('role')).toBe(false);
    expect(surface().hasAttribute('aria-labelledby')).toBe(false);
  });

  it('renders no header band when the title is hidden and there is no close button', async () => {
    const { container } = await render(BareHostComponent, {
      providers: [provideTrnIcons()],
    });

    expect(container.querySelector('header')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Switch room' }).classList,
    ).toContain('sr-only');
  });

  it('still gives its heading an id without an opening ref', async () => {
    await render(PlainHostComponent, { providers: [provideTrnIcons()] });

    expect(screen.getByRole('heading', { level: 2 }).id).toMatch(/\S/u);
  });

  it('hides the close button when not closable', async () => {
    await render(NotClosableHostComponent);

    expect(screen.queryByTestId('dialog-close')).toBeNull();
  });

  it('emits closed instead of closing when the consumer handles it', async () => {
    const { close, providers } = refFor('dialog');
    const { fixture } = await render(HandledCloseHostComponent, { providers });

    fireEvent.click(screen.getByTestId('dialog-close'));

    expect(fixture.componentInstance.onClosed).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes its dialog from the X when nobody handles closed', async () => {
    const { close, providers } = refFor('dialog');
    await render(PlainHostComponent, { providers });

    fireEvent.click(screen.getByTestId('dialog-close'));

    expect(close).toHaveBeenCalledOnce();
  });

  it('presents a sheet with a decorative handle and the sheet entrance', async () => {
    await render(PlainHostComponent, { providers: refFor('sheet').providers });

    expect(surface().getAttribute('data-trn-layout')).toBe('sheet');
    expect(surface().classList).toContain('trn-overlay-enter-sheet');
    expect(screen.getByTestId('sheet-handle').getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('keeps the sheet handle when only the X is hidden', async () => {
    await render(NotClosableHostComponent, {
      providers: refFor('sheet').providers,
    });

    expect(screen.getByTestId('sheet-handle')).toBeTruthy();
    expect(screen.queryByTestId('dialog-close')).toBeNull();
  });

  it('presents a centred dialog with the dialog entrance and no handle', async () => {
    await render(PlainHostComponent, { providers: refFor('dialog').providers });

    expect(surface().getAttribute('data-trn-layout')).toBe('dialog');
    expect(surface().classList).toContain('trn-overlay-enter-dialog');
    expect(surface().classList).not.toContain('trn-overlay-enter-sheet');
    expect(screen.queryByTestId('sheet-handle')).toBeNull();
  });

  it('fills the viewport for a fullscreen presentation, without a handle', async () => {
    await render(PlainHostComponent, {
      providers: refFor('fullscreen').providers,
    });

    expect(surface().getAttribute('data-trn-layout')).toBe('fullscreen');
    // A scale-in entrance would leave the surface short of the viewport while it plays.
    expect(surface().classList).not.toContain('trn-overlay-enter-dialog');
    expect(screen.queryByTestId('sheet-handle')).toBeNull();
  });
});
