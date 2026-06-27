import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryKeyDisplayComponent } from './recovery-key-display.component';

const KEY = 'EsTa bcde fghi jklm nopq rstu vwxy z012 3456 789a bcde fghi';

describe('RecoveryKeyDisplayComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [RecoveryKeyDisplayComponent] }),
  );

  afterEach(() => vi.restoreAllMocks());

  it('renders the recovery key', () => {
    const fixture = TestBed.createComponent(RecoveryKeyDisplayComponent);
    fixture.componentRef.setInput('recoveryKey', KEY);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.key').textContent).toContain(
      KEY,
    );
  });

  it('copies the key to the clipboard and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const fixture = TestBed.createComponent(RecoveryKeyDisplayComponent);
    fixture.componentRef.setInput('recoveryKey', KEY);
    fixture.detectChanges();

    fixture.componentInstance.copy();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(fixture.componentInstance.copied()).toBe(true);
  });

  it('downloads the key as a text file on web', () => {
    const createObjectURL = vi.fn(() => 'blob:url');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const fixture = TestBed.createComponent(RecoveryKeyDisplayComponent);
    fixture.componentRef.setInput('recoveryKey', KEY);
    fixture.detectChanges();

    fixture.componentInstance.download();

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:url');
  });

  it('surfaces a manual-copy hint when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const fixture = TestBed.createComponent(RecoveryKeyDisplayComponent);
    fixture.componentRef.setInput('recoveryKey', KEY);
    fixture.detectChanges();

    fixture.componentInstance.copy();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.copyFailed()).toBe(true);
    expect(fixture.componentInstance.copied()).toBe(false);
    expect(fixture.nativeElement.querySelector('.copy-hint')).toBeTruthy();
  });
});
