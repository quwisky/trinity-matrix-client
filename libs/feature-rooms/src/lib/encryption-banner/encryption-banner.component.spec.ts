import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CryptoService, type CryptoStatus } from '@trinity/core';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  EncryptionDialogService,
  type EncryptionDialogLoaders,
} from '@trinity/ui';
import { TrnDialogService } from '@trinity/ui-spartan';
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
let navigateByUrl: ReturnType<typeof vi.fn>;
let navigate: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  status.set('unknown');
  navigateByUrl = vi.fn();
  navigate = vi.fn().mockResolvedValue(true);
  open = vi.fn();

  TestBed.configureTestingModule({
    imports: [EncryptionBannerComponent],
    providers: [
      // The real dialog service so we exercise its desktop-vs-mobile branching.
      EncryptionDialogService,
      { provide: CryptoService, useValue: { status: status.asReadonly() } },
      { provide: Router, useValue: { navigateByUrl, navigate } },
      { provide: TrnDialogService, useValue: { open } },
      {
        provide: ENCRYPTION_DIALOG_COMPONENTS,
        useValue: {
          unlock: () => Promise.resolve(StubUnlockPage),
          verify: () => Promise.resolve(StubVerifyPage),
        } satisfies EncryptionDialogLoaders,
      },
    ],
  });
});

afterEach(() => vi.unstubAllGlobals());

function clickAction(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('ion-button')].find(
    (b) => b.textContent?.trim() === label,
  );
  (button as HTMLElement).click();
}

describe('EncryptionBannerComponent', () => {
  it('renders nothing when crypto is unknown or ready', () => {
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.banner')).toBeNull();

    status.set('ready');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.banner')).toBeNull();
  });

  it('offers a single setup action that always routes to the setup page', () => {
    stubViewport(true); // even on desktop, setup stays a full page
    status.set('needs-setup');
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('ion-button');
    expect(buttons.length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Set up encryption');

    clickAction(fixture.nativeElement, 'Set up');
    expect(navigateByUrl).toHaveBeenCalledWith('/encryption/setup');
    expect(open).not.toHaveBeenCalled();
  });

  it('lists both recovery-key and verify actions for needs-recovery', () => {
    status.set('needs-recovery');
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();

    const labels = [
      ...fixture.nativeElement.querySelectorAll('ion-button'),
    ].map((b: HTMLElement) => b.textContent?.trim());
    expect(labels).toEqual(['Use recovery key', 'Verify another device']);
  });

  it('opens unlock/verify as modals on the desktop layout', async () => {
    stubViewport(true);
    status.set('needs-recovery');
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();

    clickAction(fixture.nativeElement, 'Use recovery key');
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(StubUnlockPage, {
        inputs: { asModal: true },
        disableClose: true,
      }),
    );

    clickAction(fixture.nativeElement, 'Verify another device');
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        StubVerifyPage,
        expect.objectContaining({ inputs: { asModal: true } }),
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates to the unlock/verify routes on the mobile layout', () => {
    stubViewport(false);
    status.set('needs-recovery');
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();

    clickAction(fixture.nativeElement, 'Use recovery key');
    clickAction(fixture.nativeElement, 'Verify another device');

    expect(navigate).toHaveBeenCalledWith(['/encryption/unlock'], {});
    expect(navigate).toHaveBeenCalledWith(['/encryption/verify'], {});
    expect(open).not.toHaveBeenCalled();
  });
});
