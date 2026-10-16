import { signal } from '@angular/core';
import {
  WORKSPACE_SYSTEM_STATUS,
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrustService, type TrustStatus } from '@trinity/data-access/trust';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionBannerComponent } from './encryption-banner.component';

const status = signal<TrustStatus>('unknown');
const setupElsewhere = signal(false);
const slot = signal<'status' | 'encryption' | null>('encryption');
const slotReserved = signal(false);
const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
  of({ kind: 'presented' as const, surface: request.surface }),
);

/** Render the banner with the real dialog service and mocked collaborators. */
function renderBanner() {
  return render(EncryptionBannerComponent, {
    providers: [
      MockProvider(TrustService, {
        status: status.asReadonly(),
        recoverySetupElsewhere: setupElsewhere.asReadonly(),
      }),
      MockProvider(WorkspaceApplicationSurfaceService, { open }),
      {
        provide: WORKSPACE_SYSTEM_STATUS,
        useValue: {
          hasProblems: signal(false),
          show: vi.fn(),
          bannerSlot: slot,
          bannerSlotReserved: slotReserved,
        },
      },
    ],
  });
}

beforeEach(() => {
  status.set('unknown');
  setupElsewhere.set(false);
  slot.set('encryption');
  slotReserved.set(false);
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

  it('yields to the limited-capability banner so only one global banner shows', async () => {
    status.set('needs-setup');
    const { fixture, container } = await renderBanner();
    expect(container.querySelector('trn-banner')).not.toBeNull();

    slot.set('status');
    fixture.detectChanges();
    expect(container.querySelector('trn-banner')).toBeNull();
  });

  it('keeps its own height unless the notice it may replace has held the slot', async () => {
    status.set('needs-setup');
    const { fixture, container } = await renderBanner();
    const placement = () =>
      container.querySelector('trn-banner')?.getAttribute('data-placement');

    // Arriving in an empty slot replaces nothing, so it reserves nothing.
    expect(placement()).toBe('inline');

    // Once the two-action notice has held the slot, the prompt keeps its height.
    slotReserved.set(true);
    fixture.detectChanges();
    expect(placement()).toBe('global');
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
    expect(labels).toEqual(['Use recovery key', 'Verify with another device']);
  });

  it('opens unlock and verify through the same semantic presenter', async () => {
    status.set('needs-recovery');
    const { container } = await renderBanner();

    clickAction(container, 'Use recovery key');
    clickAction(container, 'Verify with another device');
    expect(open).toHaveBeenNthCalledWith(1, {
      surface: { kind: 'trust', flow: 'unlock' },
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      surface: { kind: 'trust', flow: 'verify' },
    });
  });

  it('offers verification, never setup, when the identity lives on another device', async () => {
    status.set('needs-verification');
    const { container } = await renderBanner();

    expect(container.querySelector('trn-banner')?.textContent).toContain(
      'verify it with one of your other devices',
    );
    const labels = [...container.querySelectorAll('trn-banner button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toEqual(['Verify with another device']);

    clickAction(container, 'Verify with another device');
    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'verify' },
    });
  });

  it('sends a verified device to the other device for recovery, never to setup', async () => {
    status.set('needs-setup');
    setupElsewhere.set(true);
    const { container } = await renderBanner();

    expect(container.querySelector('trn-banner')?.textContent).toContain(
      'Set up recovery on the device where you first set up encryption.',
    );
    // The banner cannot be dismissed, so its only action must not be destructive: the
    // reset stays in Security settings, behind its typed confirmation.
    const labels = [...container.querySelectorAll('trn-banner button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toEqual(['Security settings']);

    clickAction(container, 'Security settings');
    expect(open).toHaveBeenCalledExactlyOnceWith({
      surface: { kind: 'settings', section: 'security' },
    });
  });
});
