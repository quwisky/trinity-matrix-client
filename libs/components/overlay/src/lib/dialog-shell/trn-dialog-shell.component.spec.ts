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

  it('names the dialog by its title, also when the title is visually hidden', async () => {
    await render(HiddenTitleHostComponent, { providers: [provideTrnIcons()] });

    const heading = screen.getByRole('heading', { level: 2 });
    expect(surface().getAttribute('aria-labelledby')).toBe(heading.id);
    expect(screen.getByRole('dialog', { name: 'Switch room' })).toBe(surface());
    expect(heading.classList).toContain('sr-only');
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
    expect(screen.queryByTestId('sheet-handle')).toBeNull();
  });
});
