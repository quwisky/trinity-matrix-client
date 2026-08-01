import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrnAlertService } from './trn-alert.service';

function render(): void {
  // CDK Dialog renders its portal via the ApplicationRef; flush a tick so the
  // dialog's buttons/input are in the DOM before we interact.
  TestBed.inject(ApplicationRef).tick();
}

function clickButton(text: string): void {
  const btns = [
    ...document.querySelectorAll<HTMLButtonElement>('button[hlmBtn]'),
  ];
  btns.find((b) => b.textContent?.trim() === text)?.click();
}

describe('TrnAlertService', () => {
  it('confirm resolves true when confirmed', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = svc.confirm({
      header: 'Leave space?',
      confirmText: 'Leave',
    });
    render();
    expect(document.body.textContent).toContain('Leave space?');
    clickButton('Leave');
    expect(await result).toBe(true);
  });

  it('confirm resolves false when cancelled', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = svc.confirm({ header: 'Leave?', cancelText: 'Cancel' });
    render();
    clickButton('Cancel');
    expect(await result).toBe(false);
  });

  it('prompt resolves the typed value', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = svc.prompt({ header: 'Name', confirmText: 'Create' });
    render();
    const input = document.querySelector<HTMLInputElement>('input[hlmInput]')!;
    input.value = 'My Space';
    input.dispatchEvent(new Event('input'));
    clickButton('Create');
    expect(await result).toBe('My Space');
  });

  it('prompt resolves null on cancel', async () => {
    const svc = TestBed.inject(TrnAlertService);
    const result = svc.prompt({ header: 'Name', cancelText: 'Cancel' });
    render();
    clickButton('Cancel');
    expect(await result).toBeNull();
  });

  it('gives the prompt input an accessible name when asked', async () => {
    // A placeholder is not one: it disappears on the first keystroke, and assistive tech
    // is not obliged to announce it. A prompt whose expected input is not obvious from
    // the header has to say so somewhere a screen reader will find it.
    const svc = TestBed.inject(TrnAlertService);
    const result = svc.prompt({
      header: 'Reset encryption',
      placeholder: 'RESET',
      inputLabel: 'Type RESET to confirm',
    });
    render();

    const input = document.querySelector<HTMLInputElement>('input[hlmInput]');
    expect(input?.getAttribute('aria-label')).toBe('Type RESET to confirm');

    clickButton('Cancel');
    await result;
  });

  it('leaves the input unlabelled when the header already says it', () => {
    const svc = TestBed.inject(TrnAlertService);
    void svc.prompt({ header: 'New display name', placeholder: 'Name' });
    render();

    const input = document.querySelector<HTMLInputElement>('input[hlmInput]');
    expect(input?.hasAttribute('aria-label')).toBe(false);

    clickButton('Cancel');
  });

  it('renders a multi-line message as separate lines, not one run-on', () => {
    // HTML collapses newlines, so a message whose parts must be read one at a time
    // needs `whitespace-pre-line` — otherwise the reset's three consequences arrive as a
    // single 300-character sentence on the last screen before an irreversible action.
    const svc = TestBed.inject(TrnAlertService);
    void svc.confirm({
      header: 'Reset encryption',
      message: 'first\n\nsecond',
    });
    render();

    const paragraph = [...document.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('first'),
    );
    expect(paragraph?.className).toContain('whitespace-pre-line');
    expect(paragraph?.textContent).toContain('\n');

    clickButton('Cancel');
  });
});
