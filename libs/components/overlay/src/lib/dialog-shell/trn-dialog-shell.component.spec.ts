import { Component, type Provider } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
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
  imports: [TrnDialogShellComponent, TrnDialogActions, TrnButton],
  template: `
    <trn-dialog-shell title="Leave room?" description="You can rejoin later.">
      <p>Body</p>
      <div trnDialogActions data-testid="actions">
        <button trnBtn variant="secondary">Stay</button>
        <button trnBtn>Leave</button>
      </div>
    </trn-dialog-shell>
  `,
})
class ActionsHostComponent {}

@Component({
  imports: [TrnDialogShellComponent, TrnDialogActions, TrnButton],
  template: `
    <trn-dialog-shell title="Delete room?">
      <div trnDialogActions>
        <button trnBtn variant="danger" disabled>Delete</button>
      </div>
    </trn-dialog-shell>
  `,
})
class DisabledDangerHostComponent {}

@Component({
  imports: [TrnDialogShellComponent, TrnDialogActions, TrnButton],
  template: `
    <trn-dialog-shell title="Message source" cancelText="Close">
      <div trnDialogActions data-testid="actions">
        <button trnBtn hidden>Close</button>
      </div>
    </trn-dialog-shell>
  `,
})
class OnlyHiddenActionHostComponent {}

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

@Component({
  imports: [TrnDialogShellComponent],
  template: `<trn-dialog-shell
    title="Settings"
    closeLabel="Close settings"
    closeTestId="close-settings"
  />`,
})
class NamedCloseHostComponent {}

function refFor(
  presentation: TrnDialogPresentation,
  disableClose = false,
): {
  close: ReturnType<typeof vi.fn>;
  providers: Provider[];
} {
  const close = vi.fn();
  const ref = new TrnDialogRef(
    { closed: new Subject(), close, disableClose },
    presentation,
  );
  return {
    close,
    providers: [provideTrnIcons(), { provide: TrnDialogRef, useValue: ref }],
  };
}

/** Tailwind's `display: none` for a card with no visible row. */
const EMPTY_CARD_HIDDEN = '[&:not(:has(>:not([hidden])))]:hidden';

const surface = () => screen.getByTestId('dialog-surface');
const shell = () => document.querySelector('trn-dialog-shell')!;

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

  it('lets the host name the X and give it a test id', async () => {
    const named = await render(NamedCloseHostComponent);
    const close = named.getByRole('button', { name: 'Close settings' });
    expect(close.getAttribute('data-testid')).toBe('close-settings');
  });

  it('labels the X Close with the dialog-close test id by default', async () => {
    const { getByRole } = await render(HandledCloseHostComponent);
    expect(
      getByRole('button', { name: 'Close' }).getAttribute('data-testid'),
    ).toBe('dialog-close');
  });

  it('closes its dialog from the X when nobody handles closed', async () => {
    const { close, providers } = refFor('dialog');
    await render(PlainHostComponent, { providers });

    fireEvent.click(screen.getByTestId('dialog-close'));

    expect(close).toHaveBeenCalledOnce();
  });

  it('presents a sheet with a decorative handle and the sheet entrance', async () => {
    await render(PlainHostComponent, { providers: refFor('sheet').providers });

    // Every sheet renders through the one sheet frame.
    expect(surface().tagName).toBe('TRN-SHEET-FRAME');
    expect(surface().getAttribute('data-trn-layout')).toBe('sheet');
    expect(surface().classList).toContain('trn-overlay-enter-sheet');
    expect(screen.getByTestId('sheet-handle').getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('keeps the sheet handle when it is not closable', async () => {
    await render(NotClosableHostComponent, {
      providers: refFor('sheet').providers,
    });

    expect(screen.getByTestId('sheet-handle')).toBeTruthy();
    expect(screen.queryByTestId('dialog-close')).toBeNull();
  });

  it('sheet centres the title and shows no X', async () => {
    await render(PlainHostComponent, { providers: refFor('sheet').providers });

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    const heading = screen.getByRole('heading', { level: 2, name: 'Info' });
    expect(heading.closest('header')).toBeTruthy();
    expect(heading.classList).toContain('text-center');
  });

  it('sheet shows a Cancel block wired to close', async () => {
    const { close, providers } = refFor('sheet');
    await render(PlainHostComponent, { providers });

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('data-testid')).toBe('dialog-close');
    expect(screen.getByTestId('dialog-footer').contains(cancel)).toBe(true);
    // Row geometry and the card come from the inset primitives, over the recipe's own.
    expect(cancel.classList).toContain('py-4');
    expect(cancel.classList).toContain('justify-center');
    expect(cancel.classList).toContain('text-center');
    expect(cancel.classList).toContain('wrap-anywhere');
    expect(cancel.classList).not.toContain('px-2.5');
    expect(cancel.parentElement?.classList).toContain(
      'bg-[color:var(--trinity-neutral-fill-surface)]',
    );
    fireEvent.click(cancel);

    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0][0]).toBeUndefined();
  });

  it('Cancel emits closed when bound', async () => {
    const { close, providers } = refFor('sheet');
    const { fixture } = await render(HandledCloseHostComponent, { providers });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(fixture.componentInstance.onClosed).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('no Cancel when closable is false', async () => {
    await render(NotClosableHostComponent, {
      providers: refFor('sheet').providers,
    });

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('collapses an actions card whose only row a sheet hides', async () => {
    await render(OnlyHiddenActionHostComponent, {
      providers: refFor('sheet').providers,
    });

    const actions = screen.getByTestId('actions');
    expect(actions.classList).toContain(EMPTY_CARD_HIDDEN);
    expect(actions.matches(':not(:has(> :not([hidden])))')).toBe(true);
    expect(
      screen.getByTestId('actions').matches(':has(> :not([hidden]))'),
    ).toBe(false);
  });

  it('footer rows in a sheet', async () => {
    await render(ActionsHostComponent, {
      providers: refFor('sheet').providers,
    });

    const actions = screen.getByTestId('actions');
    expect(actions.classList).toContain(
      'bg-[color:var(--trinity-neutral-fill-surface)]',
    );
    expect(actions.classList).toContain('flex-col');
    expect(actions.classList).not.toContain('justify-end');
    // Rows draw their own dividers; clipping would cut the focus ring.
    expect(actions.classList).not.toContain('overflow-hidden');
    expect(actions.className).not.toContain('divide-');
    for (const button of actions.querySelectorAll('button')) {
      expect(button.classList).toContain('w-full');
      expect(button.classList).toContain('p-4');
    }
    // The actions card sits above the Cancel block.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(
      actions.compareDocumentPosition(cancel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('footer rows keep disabled', async () => {
    await render(DisabledDangerHostComponent, {
      providers: refFor('sheet').providers,
    });

    const remove = screen.getByRole('button', {
      name: 'Delete',
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute('data-trn-variant')).toBe('danger');
    expect(remove.getAttribute('data-trn-presentation')).toBe('ghost');
    expect(remove.classList).toContain('text-danger');
  });

  it('dialog presentation is unchanged', async () => {
    await render(ActionsHostComponent, {
      providers: refFor('dialog').providers,
    });

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    const actions = screen.getByTestId('actions');
    expect(actions.classList).toContain('justify-end');
    expect(
      screen.getByRole('button', { name: 'Leave' }).classList,
    ).not.toContain('p-4');
  });

  it('marks a sheet that draws its handle, which tightens its header', async () => {
    await render(PlainHostComponent, { providers: refFor('sheet').providers });

    expect(shell().hasAttribute('data-sheet-handle')).toBe(true);
  });

  it('leaves a sheet without a handle unmarked, so its header keeps its inset', async () => {
    await render(PlainHostComponent, {
      providers: refFor('sheet', true).providers,
    });

    expect(screen.queryByTestId('sheet-handle')).toBeNull();
    expect(shell().hasAttribute('data-sheet-handle')).toBe(false);
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
