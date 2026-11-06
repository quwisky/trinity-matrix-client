import { Component } from '@angular/core';
import { render, screen } from '@trinity/testing';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  TrnDialogRef,
  type TrnDialogPresentation,
} from '../dialog/trn-dialog-ref';
import { TrnDialogDismiss } from './trn-dialog-dismiss';
import {
  TrnDialogActions,
  TrnDialogShellComponent,
} from './trn-dialog-shell.component';

@Component({
  imports: [TrnDialogDismiss],
  template: `<button trnDialogDismiss data-testid="dismiss">Cancel</button>`,
})
class DismissHostComponent {}

@Component({
  imports: [TrnDialogShellComponent, TrnDialogActions, TrnDialogDismiss],
  template: `
    <trn-dialog-shell title="Delete account?">
      <div trnDialogActions>
        <button trnDialogDismiss data-autofocus data-testid="dismiss">
          Cancel
        </button>
      </div>
    </trn-dialog-shell>
  `,
})
class AutofocusDismissHostComponent {}

function withRef(presentation: TrnDialogPresentation) {
  return [
    {
      provide: TrnDialogRef,
      useValue: new TrnDialogRef(
        { closed: new Subject(), close: vi.fn() },
        presentation,
      ),
    },
  ];
}

describe('TrnDialogDismiss', () => {
  it('hides its host in a sheet, where the shell Cancel block dismisses', async () => {
    await render(DismissHostComponent, { providers: withRef('sheet') });

    expect(screen.getByTestId('dismiss').hidden).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('keeps its host in a dialog', async () => {
    await render(DismissHostComponent, { providers: withRef('dialog') });

    expect(screen.getByTestId('dismiss').hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('keeps its host without an opening ref', async () => {
    await render(DismissHostComponent);

    expect(screen.getByTestId('dismiss').hidden).toBe(false);
  });

  it('hands its autofocus mark to the shell Cancel block in a sheet', async () => {
    await render(AutofocusDismissHostComponent, {
      providers: withRef('sheet'),
    });

    expect(screen.getByTestId('dismiss').hasAttribute('data-autofocus')).toBe(
      false,
    );
    expect(
      screen.getByTestId('dialog-close').hasAttribute('data-autofocus'),
    ).toBe(true);
  });

  it('keeps its autofocus mark in a dialog', async () => {
    await render(AutofocusDismissHostComponent, {
      providers: withRef('dialog'),
    });

    expect(screen.getByTestId('dismiss').hasAttribute('data-autofocus')).toBe(
      true,
    );
    expect(
      screen.getByTestId('dialog-close').hasAttribute('data-autofocus'),
    ).toBe(false);
  });
});
