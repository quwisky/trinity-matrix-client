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
});
