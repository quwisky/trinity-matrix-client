import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { fireEvent, render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  type AlertDialogData,
  TrnAlertDialogComponent,
} from './trn-alert-dialog.component';

describe('TrnAlertDialogComponent', () => {
  it('gates a required prompt, clears the error, and submits its value', async () => {
    const close = vi.fn();
    const data: AlertDialogData = {
      kind: 'prompt',
      header: 'Name this space',
      confirmText: 'Create',
      cancelText: 'Cancel',
      variant: 'neutral',
      inputLabel: 'Space name',
      required: true,
    };
    const { container, fixture } = await render(TrnAlertDialogComponent, {
      providers: [
        { provide: DIALOG_DATA, useValue: data },
        { provide: DialogRef, useValue: { close } },
      ],
    });
    const input = container.querySelector('input')!;

    fireEvent.click(screen.getByTestId('alert-confirm'));
    fixture.detectChanges();

    expect(close).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('alert-prompt-error').textContent).toContain(
      'Space name is required.',
    );

    fireEvent.input(input, { target: { value: 'Core team' } });
    fixture.detectChanges();

    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByTestId('alert-prompt-error')).toBeNull();

    fireEvent.click(screen.getByTestId('alert-confirm'));
    fixture.detectChanges();

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith('Core team');
  });

  it('rejects a prompt value longer than its configured limit', async () => {
    const close = vi.fn();
    const data: AlertDialogData = {
      kind: 'prompt',
      header: 'Name this space',
      confirmText: 'Create',
      cancelText: 'Cancel',
      variant: 'neutral',
      inputLabel: 'Space name',
      maxLength: 4,
    };
    const { container, fixture } = await render(TrnAlertDialogComponent, {
      providers: [
        { provide: DIALOG_DATA, useValue: data },
        { provide: DialogRef, useValue: { close } },
      ],
    });
    const input = container.querySelector('input')!;

    fireEvent.input(input, { target: { value: 'Matrix' } });
    fireEvent.click(screen.getByTestId('alert-confirm'));
    fixture.detectChanges();

    expect(close).not.toHaveBeenCalled();
    expect(input.maxLength).toBe(4);
    expect(input.getAttribute('aria-invalid')).toBe('true');

    fireEvent.input(input, { target: { value: 'Mx' } });
    fireEvent.click(screen.getByTestId('alert-confirm'));

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith('Mx');
  });

  it('builds on the dialog shell with a text Cancel and the action in the footer', async () => {
    const data: AlertDialogData = {
      kind: 'confirm',
      header: 'Leave room?',
      message: 'You can rejoin later.',
      confirmText: 'Leave',
      cancelText: 'Cancel',
      variant: 'neutral',
    };
    await render(TrnAlertDialogComponent, {
      providers: [
        { provide: DIALOG_DATA, useValue: data },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const surface = screen.getByTestId('alert-surface');
    expect(surface.tagName.toLowerCase()).toBe('trn-dialog-shell');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Leave room?' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('dialog-close')).toBeNull();
    const footer = screen.getByTestId('dialog-footer');
    expect(footer.contains(screen.getByTestId('alert-confirm'))).toBe(true);
    expect(footer.contains(screen.getByTestId('alert-cancel'))).toBe(true);
    // jsdom has no Tailwind, so the presentation is read from the recipe's class contract.
    expect(screen.getByTestId('alert-cancel').className).toContain(
      'underline-offset-4',
    );
    expect(screen.getByTestId('alert-confirm').className).not.toContain(
      'underline-offset-4',
    );
  });

  it('confirms a danger alert with the solid danger action', async () => {
    const data: AlertDialogData = {
      kind: 'confirm',
      header: 'Delete?',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
    };
    await render(TrnAlertDialogComponent, {
      providers: [
        { provide: DIALOG_DATA, useValue: data },
        { provide: DialogRef, useValue: { close: vi.fn() } },
      ],
    });

    const confirm = screen.getByTestId('alert-confirm');
    expect(confirm.getAttribute('data-trn-variant')).toBe('danger');
    expect(confirm.className).toContain(
      'bg-[color:var(--trinity-danger-solid)]',
    );
  });
});
