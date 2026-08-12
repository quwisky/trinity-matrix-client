import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { TrnActionSheetService } from './trn-action-sheet.service';

function render(): void {
  TestBed.inject(ApplicationRef).tick();
}

function clickButton(text: string): void {
  [...document.querySelectorAll<HTMLButtonElement>('button[trnBtn]')]
    .find((b) => b.textContent?.trim() === text)
    ?.click();
}

describe('TrnActionSheetService', () => {
  it('renders the header + buttons and runs a picked handler', () => {
    const svc = TestBed.inject(TrnActionSheetService);
    const handler = vi.fn();
    svc.open({
      header: 'New message',
      buttons: [
        { text: 'Create a room', handler },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
    render();

    expect(document.body.textContent).toContain('New message');
    clickButton('Create a room');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not run a handler for the cancel button', () => {
    const svc = TestBed.inject(TrnActionSheetService);
    const handler = vi.fn();
    svc.open({ buttons: [{ text: 'Cancel', role: 'cancel', handler }] });
    render();

    clickButton('Cancel');
    expect(handler).not.toHaveBeenCalled();
  });
});
