import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CryptoService, type CryptoStatus } from '@trinity/data-access/crypto';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  EncryptionDialogService,
  type EncryptionDialogLoaders,
} from '@trinity/components/encryption-dialog';
import { TrnDialogService } from '@trinity/components/overlay';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionBannerComponent } from './encryption-banner.component';

@Component({ selector: 'trn-stub-unlock', template: '' })
class StubUnlockPage {}
@Component({ selector: 'trn-stub-verify', template: '' })
class StubVerifyPage {}

/** Pretend the viewport is (or isn't) the desktop split-pane layout. */
function stubViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches }));
}

const status = signal<CryptoStatus>('unknown');

/** Render the banner with the real dialog service and mocked collaborators. */
function renderBanner() {
  return render(EncryptionBannerComponent, {
    providers: [
      // The real dialog service so we exercise its desktop-vs-mobile branching.
      EncryptionDialogService,
      MockProvider(CryptoService, { status: status.asReadonly() }),
      MockProvider(Router, { navigate: vi.fn().mockResolvedValue(true) }),
      MockProvider(TrnDialogService),
      {
        provide: ENCRYPTION_DIALOG_COMPONENTS,
        useValue: {
          unlock: () => Promise.resolve(StubUnlockPage),
          verify: () => Promise.resolve(StubVerifyPage),
        } satisfies EncryptionDialogLoaders,
      },
    ],
  });
}

beforeEach(() => {
  status.set('unknown');
});

afterEach(() => vi.unstubAllGlobals());

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

  it('offers a single setup action that always routes to the setup page', async () => {
    stubViewport(true); // even on desktop, setup stays a full page
    status.set('needs-setup');
    const { container } = await renderBanner();

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(container.textContent).toContain('Set up encryption');

    const router = TestBed.inject(Router);
    const dialog = TestBed.inject(TrnDialogService);
    clickAction(container, 'Set up');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/encryption/setup');
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('lists both recovery-key and verify actions for needs-recovery', async () => {
    status.set('needs-recovery');
    const { container } = await renderBanner();

    const labels = [...container.querySelectorAll('button')].map(
      (b: HTMLElement) => b.textContent?.trim(),
    );
    expect(labels).toEqual(['Use recovery key', 'Verify another device']);
  });

  it('opens unlock/verify as modals on the desktop layout', async () => {
    stubViewport(true);
    status.set('needs-recovery');
    const { container } = await renderBanner();

    const dialog = TestBed.inject(TrnDialogService);
    const router = TestBed.inject(Router);

    clickAction(container, 'Use recovery key');
    await vi.waitFor(() =>
      expect(dialog.open).toHaveBeenCalledWith(StubUnlockPage, {
        inputs: { asModal: true },
        disableClose: true,
        ariaLabel: 'Encryption',
      }),
    );

    clickAction(container, 'Verify another device');
    await vi.waitFor(() =>
      expect(dialog.open).toHaveBeenCalledWith(
        StubVerifyPage,
        expect.objectContaining({ inputs: { asModal: true } }),
      ),
    );
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('navigates to the unlock/verify routes on the mobile layout', async () => {
    stubViewport(false);
    status.set('needs-recovery');
    const { container } = await renderBanner();

    const dialog = TestBed.inject(TrnDialogService);
    const router = TestBed.inject(Router);

    clickAction(container, 'Use recovery key');
    clickAction(container, 'Verify another device');

    await vi.waitFor(() => {
      expect(router.navigate).toHaveBeenCalledWith(['/encryption/unlock'], {});
      expect(router.navigate).toHaveBeenCalledWith(['/encryption/verify'], {});
    });
    expect(dialog.open).not.toHaveBeenCalled();
  });
});
