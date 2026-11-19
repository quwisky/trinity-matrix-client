import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrnToastService } from '../toast/trn-toast.service';
import { TrnActionSheetService } from './trn-action-sheet.service';

function render(): void {
  TestBed.inject(ApplicationRef).tick();
}

describe('TrnActionSheetService — loading the list on first use', () => {
  afterEach(() => {
    vi.doUnmock('./trn-action-list.component');
    document
      .querySelectorAll('.cdk-overlay-container')
      .forEach((el) => el.remove());
  });

  it('shows a list asked for before its code arrived', async () => {
    const ref = TestBed.inject(TrnActionSheetService).open({
      buttons: [{ text: 'Reply' }],
    });
    expect(ref.presentation).toBe('sheet');
    expect(ref.surface).toBeNull();

    await vi.dynamicImportSettled();
    render();

    expect(document.body.textContent).toContain('Reply');
    expect(ref.surface).toBe(
      document.querySelector('[data-testid=action-sheet-surface]'),
    );
  });

  it('never shows a list its opener closed while the code was loading', async () => {
    const ref = TestBed.inject(TrnActionSheetService).open({
      buttons: [{ text: 'Reply' }],
    });
    const closed = vi.fn();
    ref.closed.subscribe(closed);

    ref.close();
    await vi.dynamicImportSettled();
    render();

    expect(closed).toHaveBeenCalledOnce();
    expect(document.querySelector('trn-action-list')).toBeNull();
  });

  it('says so and ends the invocation when the code cannot be loaded, then retries', async () => {
    const svc = TestBed.inject(TrnActionSheetService);
    const show = vi.spyOn(TestBed.inject(TrnToastService), 'show');
    vi.doMock('./trn-action-list.component', () => {
      throw new Error('chunk unavailable');
    });
    const failed = svc.open({ buttons: [{ text: 'Reply' }] });
    const closed = vi.fn();
    failed.closed.subscribe(closed);

    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    render();

    expect(show).toHaveBeenCalledWith(
      'Could not open the menu. Please try again.',
      { duration: 5000, variant: 'danger' },
    );
    expect(document.querySelector('trn-action-list')).toBeNull();

    vi.doUnmock('./trn-action-list.component');
    svc.open({ buttons: [{ text: 'Reply' }] });
    await vi.dynamicImportSettled();
    render();

    expect(document.body.textContent).toContain('Reply');
    expect(show).toHaveBeenCalledOnce();
  });
});
