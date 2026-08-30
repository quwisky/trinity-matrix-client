import { signal } from '@angular/core';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { CryptoService, type CryptoStatus } from '@trinity/data-access/crypto';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionBannerComponent } from './encryption-banner.component';

const status = signal<CryptoStatus>('unknown');
const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
  of({ kind: 'presented' as const, surface: request.surface }),
);

/** Render the banner with the real dialog service and mocked collaborators. */
function renderBanner() {
  return render(EncryptionBannerComponent, {
    providers: [
      MockProvider(CryptoService, { status: status.asReadonly() }),
      MockProvider(WorkspaceApplicationSurfaceService, { open }),
    ],
  });
}

beforeEach(() => {
  status.set('unknown');
  open.mockClear();
});

function clickAction(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  fireEvent.click(button as HTMLElement);
}

describe('EncryptionBannerComponent', () => {
  it('renders nothing when crypto is unknown or ready', async () => {
    const { fixture, container } = await renderBanner();
    expect(container.querySelector('.banner')).toBeNull();

    status.set('ready');
    fixture.detectChanges();
    expect(container.querySelector('.banner')).toBeNull();
  });

  it('mirrors the prompt in an always-mounted live region', async () => {
    const { container, fixture } = await renderBanner();
    const liveRegion = () => container.querySelector('.sr-only[role="status"]');

    // Persistent and empty while there's nothing to prompt: a role="status" region
    // must exist before its text changes to be reliably announced, so the message is
    // mirrored here rather than only inside the @if banner.
    expect(liveRegion()).not.toBeNull();
    expect(liveRegion()?.textContent?.trim()).toBe('');

    status.set('needs-setup');
    fixture.detectChanges();

    expect(liveRegion()?.textContent).toContain('Set up encryption');
  });

  it('offers a single setup action as a semantic trust surface', async () => {
    status.set('needs-setup');
    const { container } = await renderBanner();

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(container.textContent).toContain('Set up encryption');

    clickAction(container, 'Set up');
    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'setup' },
    });
  });

  it('lists both recovery-key and verify actions for needs-recovery', async () => {
    status.set('needs-recovery');
    const { container } = await renderBanner();

    const labels = [...container.querySelectorAll('button')].map(
      (b: HTMLElement) => b.textContent?.trim(),
    );
    expect(labels).toEqual(['Use recovery key', 'Verify another device']);
  });

  it('opens unlock and verify through the same semantic presenter', async () => {
    status.set('needs-recovery');
    const { container } = await renderBanner();

    clickAction(container, 'Use recovery key');
    clickAction(container, 'Verify another device');
    expect(open).toHaveBeenNthCalledWith(1, {
      surface: { kind: 'trust', flow: 'unlock' },
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      surface: { kind: 'trust', flow: 'verify' },
    });
  });
});
