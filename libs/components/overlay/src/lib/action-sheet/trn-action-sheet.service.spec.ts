import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrnActionSheetService } from './trn-action-sheet.service';

function render(): void {
  TestBed.inject(ApplicationRef).tick();
}

function clickButton(text: string): void {
  [...document.querySelectorAll<HTMLButtonElement>('button[hlmBtn]')]
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

describe('TrnActionSheetService — the message-sheet surface', () => {
  afterEach(() => {
    document
      .querySelectorAll('.cdk-overlay-container')
      .forEach((el) => el.remove());
  });

  it('hands back a ref the opener can close', () => {
    // A sheet that only closes itself outlives what it acts on: the timeline destroys a
    // row when it is redacted, edited, or scrolled out of the virtual window, and a sheet
    // still standing over a dead row offers actions that quietly do nothing.
    const svc = TestBed.inject(TrnActionSheetService);
    const ref = svc.open({ buttons: [{ text: 'Reply' }] });
    render();
    expect(document.body.textContent).toContain('Reply');

    ref.close();
    render();

    expect(document.querySelector('trn-action-sheet')).toBeNull();
  });

  it('names the dialog, so a screen reader does not just say "dialog"', () => {
    const svc = TestBed.inject(TrnActionSheetService);
    svc.open({ buttons: [{ text: 'Reply' }] }, 'Message actions');
    render();

    const pane = document.querySelector('.cdk-overlay-pane [role=dialog]');
    expect(pane?.getAttribute('aria-label')).toBe('Message actions');
  });

  it('falls back to the header for the accessible name', () => {
    const svc = TestBed.inject(TrnActionSheetService);
    svc.open({ header: 'New message', buttons: [{ text: 'Create a room' }] });
    render();

    const pane = document.querySelector('.cdk-overlay-pane [role=dialog]');
    expect(pane?.getAttribute('aria-label')).toBe('New message');
  });

  it('offers reactions as a strip, and picking one closes the sheet', () => {
    const svc = TestBed.inject(TrnActionSheetService);
    const react = vi.fn();
    svc.open({
      reactions: [
        { key: '👍', handler: react },
        { key: '❤️', handler: () => undefined },
      ],
      buttons: [{ text: 'Reply' }],
    });
    render();

    // Matched by PREFIX: jsdom's selector engine cannot parse an unescaped emoji inside
    // an attribute value, so `[data-testid="sheet-react-👍"]` silently matches nothing.
    const strip = document.querySelectorAll<HTMLButtonElement>(
      '[data-testid^="sheet-react-"]',
    );
    expect(strip.length).toBe(2);
    const thumb = strip[0];
    expect(thumb?.getAttribute('aria-label')).toBe('React with 👍');

    thumb?.click();
    render();

    expect(react).toHaveBeenCalledTimes(1);
    expect(document.querySelector('trn-action-sheet')).toBeNull();
  });

  it('marks a destructive row with text-danger, not text-destructive', () => {
    // `--destructive` is a FILL token — a near-black maroon in dark mode, 1.26:1 as text.
    // Alert text is `--trinity-danger`, which the `text-danger` utility maps to.
    const svc = TestBed.inject(TrnActionSheetService);
    svc.open({
      buttons: [{ text: 'Delete message', role: 'destructive', testId: 'del' }],
    });
    render();

    const row = document.querySelector('[data-testid=del]');
    expect(row?.classList.contains('text-danger')).toBe(true);
    expect(row?.classList.contains('text-destructive')).toBe(false);
  });

  it('puts every row in a scroller rather than clipping the list', () => {
    // Thirteen rows is what a message sheet actually offers. The component was one
    // `overflow-hidden` box with no height bound, and CDK clamps the pane to the
    // viewport — so at 360x640 the last row fell outside with no scrollbar and no
    // affordance. jsdom has no layout, so this asserts the STRUCTURE that fixes it:
    // every row inside an element that can scroll. The geometry is measured in
    // `e2e/playwright/message-action-sheet.spec.mts`.
    const svc = TestBed.inject(TrnActionSheetService);
    svc.open({
      buttons: Array.from({ length: 13 }, (_, i) => ({
        text: `Action ${i}`,
        testId: `row-${i}`,
      })),
    });
    render();

    const last = document.querySelector('[data-testid=row-12]');
    expect(last).not.toBeNull();
    const scroller = last?.closest('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller?.querySelectorAll('button[hlmBtn]').length).toBe(13);
  });

  it('draws a rule before a row that asks for one', () => {
    const svc = TestBed.inject(TrnActionSheetService);
    svc.open({
      buttons: [
        { text: 'Edit message' },
        { text: 'Delete message', role: 'destructive', separatorBefore: true },
      ],
    });
    render();

    expect(document.querySelector('[role=separator]')).not.toBeNull();
  });
});
