import { render, screen } from '@trinity/testing';
import { HostFileExportService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryKeyDisplayComponent } from './recovery-key-display.component';

const KEY = 'EsTa bcde fghi jklm nopq rstu vwxy z012 3456 789a bcde fghi';

describe('RecoveryKeyDisplayComponent', () => {
  const save = vi.fn(
    (_request: { readonly bytes: Blob; readonly filename: string }) =>
      of({ kind: 'completed' as const }),
  );

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => save.mockClear());

  function renderKey() {
    return render(RecoveryKeyDisplayComponent, {
      inputs: { recoveryKey: KEY },
      providers: [
        MockProvider(HostFileExportService, {
          support: () => of({ kind: 'supported' as const }),
          save,
        }),
      ],
    });
  }

  it('renders the recovery key', async () => {
    const { container } = await renderKey();

    expect(container.querySelector('.key')?.textContent).toContain(KEY);
  });

  it('copies the key to the clipboard and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { fixture } = await renderKey();

    fixture.componentInstance.copy();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(fixture.componentInstance.copied()).toBe(true);
  });

  it('downloads the key as a text file on web', async () => {
    const { fixture } = await renderKey();

    fixture.componentInstance.download();

    expect(save).toHaveBeenCalledWith({
      bytes: expect.any(Blob),
      filename: 'trinity-recovery-key.txt',
    });
    const [{ bytes }] = save.mock.calls[0];
    await expect(bytes.text()).resolves.toBe(KEY);
  });

  it('surfaces a manual-copy hint when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { fixture } = await renderKey();

    fixture.componentInstance.copy();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.copyFailed()).toBe(true);
    expect(fixture.componentInstance.copied()).toBe(false);
    expect(
      screen.getByText(/select the key above and copy it manually/i),
    ).toBeInTheDocument();
  });
});
