import { ApplicationRef } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { screen } from '@trinity/testing';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrnAlertService } from './trn-alert.service';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

function render(): void {
  // CDK Dialog renders its portal via the ApplicationRef; flush a tick so the
  // dialog's buttons/input are in the DOM before we interact.
  TestBed.inject(ApplicationRef).tick();
}

function clickButton(text: string): void {
  const btns = [
    ...document.querySelectorAll<HTMLButtonElement>('button[trnBtn]'),
  ];
  btns.find((b) => b.textContent?.trim() === text)?.click();
}

describe('TrnAlertService', () => {
  it('opens a confirm as a sheet on a tablet at desktop width', () => {
    platform.mobile = true;
    try {
      TestBed.inject(TrnAlertService)
        .confirm$({ header: 'Leave room?', confirmText: 'Leave' })
        .subscribe();
      render();

      expect(
        document
          .querySelector('[data-testid=alert-surface] [data-trn-layout]')
          ?.getAttribute('data-trn-layout'),
      ).toBe('sheet');
    } finally {
      platform.mobile = false;
      TestBed.inject(Dialog).closeAll();
    }
  });

  it('keeps the reactive confirmation command cold', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const command = svc.confirm$({
      header: 'Leave space?',
      confirmText: 'Leave',
    });

    expect(document.querySelector('trn-alert-dialog')).toBeNull();
    const result = firstValueFrom(command);
    render();
    expect(document.querySelector('trn-alert-dialog')).not.toBeNull();
    clickButton('Leave');

    expect(await result).toBe(true);
  });

  it('confirm resolves true when confirmed', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = firstValueFrom(
      svc.confirm$({ header: 'Leave space?', confirmText: 'Leave' }),
    );
    render();
    expect(document.body.textContent).toContain('Leave space?');
    clickButton('Leave');
    expect(await result).toBe(true);
  });

  it('confirm resolves false when cancelled', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = firstValueFrom(
      svc.confirm$({
        header: 'Leave?',
        confirmText: 'Leave',
        cancelText: 'Cancel',
      }),
    );
    render();
    clickButton('Cancel');
    expect(await result).toBe(false);
  });

  it('can keep a route-guard confirmation open across navigation cancellation', async () => {
    const dialog = TestBed.inject(Dialog);
    const open = vi.spyOn(dialog, 'open');
    const result = firstValueFrom(
      TestBed.inject(TrnAlertService).confirm$({
        header: 'Discard changes?',
        confirmText: 'Discard',
        closeOnNavigation: false,
      }),
    );
    render();

    expect(open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ closeOnNavigation: false }),
    );
    clickButton('Cancel');
    expect(await result).toBe(false);
  });

  it('prompt resolves the typed value', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = firstValueFrom(
      svc.prompt$({ header: 'Name', confirmText: 'Create' }),
    );
    render();
    const input = document.querySelector<HTMLInputElement>('input[trnInput]')!;
    input.value = 'My Space';
    input.dispatchEvent(new Event('input'));
    clickButton('Create');
    expect(await result).toBe('My Space');
  });

  it('prompt resolves null on cancel', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = firstValueFrom(
      svc.prompt$({
        header: 'Name',
        confirmText: 'Create',
        cancelText: 'Cancel',
      }),
    );
    render();
    clickButton('Cancel');
    expect(await result).toBeNull();
  });

  it('gives the prompt input an accessible name when asked', async () => {
    // A placeholder is not one: it disappears on the first keystroke, and assistive tech
    // is not obliged to announce it. A prompt whose expected input is not obvious from
    // the header has to say so somewhere a screen reader will find it.
    const svc = TestBed.inject(TrnAlertService);
    const result = firstValueFrom(
      svc.prompt$({
        header: 'Reset encryption',
        confirmText: 'Reset',
        placeholder: 'RESET',
        inputLabel: 'Type RESET to confirm',
      }),
    );
    render();

    const input = document.querySelector<HTMLInputElement>('input[trnInput]');
    expect(input?.getAttribute('aria-label')).toBe('Type RESET to confirm');

    clickButton('Cancel');
    await result;
  });

  it('leaves the input unlabelled when the header already says it', () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = firstValueFrom(
      svc.prompt$({
        header: 'New display name',
        placeholder: 'Name',
        confirmText: 'Save',
      }),
    );
    render();

    const input = document.querySelector<HTMLInputElement>('input[trnInput]');
    expect(input?.hasAttribute('aria-label')).toBe(false);

    clickButton('Cancel');
    void result;
  });

  it('renders a multi-line message as separate lines, not one run-on', () => {
    // HTML collapses newlines, so a message whose parts must be read one at a time
    // needs `whitespace-pre-line` — otherwise the reset's three consequences arrive as a
    // single 300-character sentence on the last screen before an irreversible action.
    const svc = TestBed.inject(TrnAlertService);
    const result = firstValueFrom(
      svc.confirm$({
        header: 'Reset encryption',
        confirmText: 'Reset',
        message: 'first\n\nsecond',
      }),
    );
    render();

    const paragraph = [...document.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('first'),
    );
    expect(paragraph?.className).toContain('whitespace-pre-line');
    expect(paragraph?.textContent).toContain('\n');

    clickButton('Cancel');
    void result;
  });

  it('renders the canonical danger appearance', async () => {
    const svc = TestBed.inject(TrnAlertService);

    const canonical = firstValueFrom(
      svc.confirm$({
        header: 'Canonical danger',
        confirmText: 'Delete',
        variant: 'danger',
      }),
    );
    render();
    const canonicalButton = document.querySelector<HTMLElement>(
      '[data-testid=alert-confirm]',
    );
    expect(canonicalButton?.dataset['trnVariant']).toBe('danger');
    clickButton('Cancel');
    await canonical;
  });

  describe('on a phone', () => {
    afterEach(() => {
      TestBed.inject(Dialog).closeAll();
      vi.restoreAllMocks();
    });

    it('opens a prompt as a full-width bottom sheet', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query === BELOW_MD_QUERY,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }) as unknown as MediaQueryList,
      );
      const svc = TestBed.inject(TrnAlertService);

      svc.prompt$({ header: 'Reason', confirmText: 'Report' }).subscribe();
      render();

      expect(
        document
          .querySelector('[data-testid="dialog-surface"]')
          ?.getAttribute('data-trn-layout'),
      ).toBe('sheet');
      expect(
        document.querySelector<HTMLElement>('.cdk-overlay-pane')?.style.width,
      ).toBe('100vw');
    });
  });

  describe('dialog semantics', () => {
    afterEach(() => TestBed.inject(Dialog).closeAll());

    it('exposes one dialog role, named by its visible title', () => {
      TestBed.inject(TrnAlertService)
        .confirm$({ header: 'Leave space?', confirmText: 'Leave' })
        .subscribe();
      render();

      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      const dialog = screen.getByRole('dialog', { name: 'Leave space?' });
      expect(dialog.hasAttribute('aria-label')).toBe(false);
      expect(
        document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')
          ?.tagName,
      ).toBe('H2');
    });

    it('keeps a desktop alert free of pane geometry, so CDK defaults stand', () => {
      TestBed.inject(TrnAlertService)
        .confirm$({ header: 'Leave space?', confirmText: 'Leave' })
        .subscribe();
      render();

      const pane = document.querySelector<HTMLElement>('.cdk-overlay-pane');
      expect(pane?.style.width).toBe('');
      expect(pane?.style.maxWidth).toBe('');
      expect(pane?.style.maxHeight).toBe('');
    });
  });
});
