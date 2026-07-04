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
});
