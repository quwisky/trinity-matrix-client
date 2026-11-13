import { signal } from '@angular/core';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrustService, type VerifyBlock } from '@trinity/data-access/trust';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, defer, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { VerifyNeedsSetupComponent } from './verify-needs-setup.component';

const ENTER_RECOVERY_KEY: VerifyBlock = {
  reason:
    'This device doesn’t have all its keys yet. Enter your recovery key to verify people.',
  action: { label: 'Enter recovery key', flow: 'unlock' },
};

async function build(
  block: VerifyBlock | null,
  refreshWith?: (
    verifyBlock: ReturnType<typeof signal<VerifyBlock | null>>,
  ) => Observable<void>,
) {
  const open = vi.fn(() => of({ kind: 'presented' }));
  const opened = vi.fn();
  const verifyBlock = signal(block);
  const refresh = vi.fn(() => refreshWith?.(verifyBlock) ?? of(undefined));
  const { container } = await render(VerifyNeedsSetupComponent, {
    on: { opened },
    providers: [
      MockProvider(WorkspaceApplicationSurfaceService, { open: open as never }),
      MockProvider(TrustService, { verifyBlock, refresh }),
    ],
  });
  return { container, open, opened, refresh };
}

// Which text and flow belong to which device state is `deriveVerifyBlock`'s spec.
describe('VerifyNeedsSetupComponent', () => {
  it('says what this device needs and opens the flow that provides it', async () => {
    const { container, open, opened } = await build(ENTER_RECOVERY_KEY);

    expect(container.textContent).toContain(ENTER_RECOVERY_KEY.reason);
    fireEvent.click(screen.getByRole('button', { name: 'Enter recovery key' }));

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'unlock' },
    });
    expect(opened).toHaveBeenCalledOnce();
  });

  it('offers no button where no flow on this device would help', async () => {
    const { container } = await build({
      reason:
        'Verify people from the device where you set up encryption, or set up recovery there.',
      action: null,
    });

    expect(container.textContent).toContain(
      'Verify people from the device where you set up encryption, or set up recovery there.',
    );
    expect(container.querySelector('button')).toBeNull();
  });

  // The projected status can be stale, and the keys can still be on their way.
  it('asks nothing of the user until this device has been read again', async () => {
    const { container, refresh } = await build(ENTER_RECOVERY_KEY, () => NEVER);

    expect(refresh).toHaveBeenCalledOnce();
    expect(container.textContent?.trim()).toBe('Checking this device…');
    expect(container.querySelector('button')).toBeNull();
  });

  // A failed read leaves the service with no current state, so there is nothing to act on.
  it('asks nothing of the user when the fresh read fails', async () => {
    const { container } = await build(ENTER_RECOVERY_KEY, (verifyBlock) =>
      defer(() => {
        verifyBlock.set(null);
        return throwError(() => new Error('offline'));
      }),
    );

    expect(container.textContent?.trim()).toBe('Checking this device…');
    expect(container.querySelector('button')).toBeNull();
  });
});
