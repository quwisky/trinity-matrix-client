import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CryptoService, type CryptoStatus } from '@trinity/data-access-crypto';
import { EncryptionDialogService } from '@trinity/ui';
import { SecuritySectionComponent } from './security-section.component';

async function build(
  opts: {
    status?: CryptoStatus;
    verified?: boolean;
    backup?: boolean;
  } = {},
) {
  const refresh = vi.fn(() => of(undefined));
  const openUnlock = vi.fn().mockResolvedValue(undefined);
  const openVerify = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue(true);
  const { fixture, container } = await render(SecuritySectionComponent, {
    providers: [
      MockProvider(CryptoService, {
        status: signal<CryptoStatus>(opts.status ?? 'ready').asReadonly(),
        keyBackupActive: signal(opts.backup ?? false).asReadonly(),
        thisDeviceVerified: signal(opts.verified ?? false).asReadonly(),
        refresh,
      }),
      MockProvider(EncryptionDialogService, { openUnlock, openVerify }),
      MockProvider(Router, { navigate }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
    refresh,
    openUnlock,
    openVerify,
    navigate,
  };
}

describe('SecuritySectionComponent', () => {
  it('refreshes the crypto status on open', async () => {
    const { refresh } = await build();
    expect(refresh).toHaveBeenCalled();
  });

  it('offers setup when encryption needs setting up', async () => {
    const { container, cmp, navigate } = await build({ status: 'needs-setup' });
    expect(
      container.querySelector('[data-testid=security-setup]'),
    ).not.toBeNull();

    cmp.setUp();

    expect(navigate).toHaveBeenCalledWith(['/encryption/setup'], {
      queryParams: { returnTo: '/settings/security' },
    });
  });

  it('offers recovery-key unlock when this device needs recovery', async () => {
    const { container, cmp, openUnlock } = await build({
      status: 'needs-recovery',
    });
    expect(
      container.querySelector('[data-testid=security-unlock]'),
    ).not.toBeNull();

    cmp.unlock();

    expect(openUnlock).toHaveBeenCalledWith({ returnTo: '/settings/security' });
  });

  it('shows the secured state when encryption is ready (no fix action)', async () => {
    const { container } = await build({ status: 'ready' });
    expect(container.textContent).toContain('secured with end-to-end');
    expect(container.querySelector('[data-testid=security-setup]')).toBeNull();
    expect(container.querySelector('[data-testid=security-unlock]')).toBeNull();
  });

  it('offers session verification when this session is unverified', async () => {
    const { container, cmp, openVerify } = await build({ verified: false });
    expect(
      container.querySelector('[data-testid=security-verify]'),
    ).not.toBeNull();

    cmp.verifySession();

    expect(openVerify).toHaveBeenCalledWith({ returnTo: '/settings/security' });
  });

  it('marks the session verified and hides the verify action when verified', async () => {
    const { container } = await build({ verified: true });
    expect(
      container.querySelector('[data-testid=security-session-verified]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid=security-verify]')).toBeNull();
  });

  it('reflects an active key backup', async () => {
    const { container } = await build({ backup: true });
    expect(container.textContent).toContain('backed up to the server');
  });

  it('reflects key backup being off', async () => {
    const { container } = await build({ backup: false });
    expect(container.textContent).toContain('Key backup is off');
  });
});
