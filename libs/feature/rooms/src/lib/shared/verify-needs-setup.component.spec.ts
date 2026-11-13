import { signal } from '@angular/core';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrustService, type TrustStatus } from '@trinity/data-access/trust';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { VerifyNeedsSetupComponent } from './verify-needs-setup.component';

async function build(
  status: TrustStatus,
  options: { setupElsewhere?: boolean; refresh?: Observable<void> } = {},
) {
  const open = vi.fn(() => of({ kind: 'presented' }));
  const opened = vi.fn();
  const refresh = vi.fn(() => options.refresh ?? of(undefined));
  const { container } = await render(VerifyNeedsSetupComponent, {
    on: { opened },
    providers: [
      MockProvider(WorkspaceApplicationSurfaceService, { open: open as never }),
      MockProvider(TrustService, {
        status: signal(status),
        recoverySetupElsewhere: signal(options.setupElsewhere ?? false),
        refresh,
      }),
    ],
  });
  return { container, open, opened, refresh };
}

describe('VerifyNeedsSetupComponent', () => {
  // `ready` is the state Security settings has no action for: recovery exists, the device
  // is verified, and the user-signing key was never fetched.
  it.each([
    [
      'ready',
      'This device doesn’t have all its keys yet. Enter your recovery key to verify people.',
      'Enter recovery key',
      'unlock',
    ],
    [
      'needs-recovery',
      'This device doesn’t have all its keys yet. Enter your recovery key to verify people.',
      'Enter recovery key',
      'unlock',
    ],
    [
      'needs-verification',
      'Verify this device before you verify people.',
      'Verify this device',
      'verify',
    ],
    [
      'needs-setup',
      'Set up encryption on this device to verify people.',
      'Set up encryption',
      'setup',
    ],
  ] as const)(
    'offers the flow that brings the keys here when the status is %s',
    async (status, reason, label, flow) => {
      const { container, open, opened } = await build(status);

      expect(container.textContent).toContain(reason);
      fireEvent.click(screen.getByRole('button', { name: label }));

      expect(open).toHaveBeenCalledWith({ surface: { kind: 'trust', flow } });
      expect(opened).toHaveBeenCalledOnce();
    },
  );

  // The only thing this device could do there is replace the identity.
  it('offers nothing, least of all a reset, when the keys are only on another device', async () => {
    const { container } = await build('needs-setup', { setupElsewhere: true });

    expect(container.textContent).toContain(
      'Verify people from the device where you set up encryption, or set up recovery there.',
    );
    expect(container.querySelector('button')).toBeNull();
  });

  // The projected status can be stale, and the keys can still be on their way.
  it('asks nothing of the user until this device has been read again', async () => {
    const { container, refresh } = await build('ready', { refresh: NEVER });

    expect(refresh).toHaveBeenCalledOnce();
    expect(container.textContent?.trim()).toBe('Checking this device…');
    expect(container.querySelector('button')).toBeNull();
  });

  it('still says what to do when the fresh read fails', async () => {
    await build('ready', { refresh: throwError(() => new Error('offline')) });

    expect(
      screen.getByRole('button', { name: 'Enter recovery key' }),
    ).toBeTruthy();
  });
});
