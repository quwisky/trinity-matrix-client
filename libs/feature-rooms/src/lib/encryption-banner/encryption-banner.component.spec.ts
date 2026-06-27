import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CryptoService, type CryptoStatus } from '@trinity/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionBannerComponent } from './encryption-banner.component';

describe('EncryptionBannerComponent', () => {
  const status = signal<CryptoStatus>('unknown');
  let navigateByUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    status.set('unknown');
    navigateByUrl = vi.fn();
    TestBed.configureTestingModule({
      imports: [EncryptionBannerComponent],
      providers: [
        { provide: CryptoService, useValue: { status: status.asReadonly() } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
  });

  it('renders nothing when crypto is unknown or ready', () => {
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.banner')).toBeNull();

    status.set('ready');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.banner')).toBeNull();
  });

  it('offers a single setup action for needs-setup', () => {
    status.set('needs-setup');
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('ion-button');
    expect(buttons.length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Set up encryption');
    fixture.componentInstance.go('/encryption/setup');
    expect(navigateByUrl).toHaveBeenCalledWith('/encryption/setup');
  });

  it('offers both recovery-key and verify actions for needs-recovery', () => {
    status.set('needs-recovery');
    const fixture = TestBed.createComponent(EncryptionBannerComponent);
    fixture.detectChanges();

    const labels = [
      ...fixture.nativeElement.querySelectorAll('ion-button'),
    ].map((b: HTMLElement) => b.textContent?.trim());
    expect(labels).toEqual(['Use recovery key', 'Verify another device']);

    fixture.componentInstance.go('/encryption/verify');
    expect(navigateByUrl).toHaveBeenCalledWith('/encryption/verify');
  });
});
