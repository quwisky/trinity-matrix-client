import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { CryptoService, type CryptoStatus } from '@trinity/data-access/crypto';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { EncryptionDialogService } from '@trinity/ui';
import { SecuritySectionComponent } from './security-section.component';

async function build(
  opts: {
    status?: CryptoStatus;
    verified?: boolean;
    backup?: boolean;
  } = {},
  over: {
    exportRoomKeys?: Mock;
    importRoomKeys?: Mock;
    prompt?: Mock;
  } = {},
) {
  const refresh = vi.fn(() => of(undefined));
  const openUnlock = vi.fn().mockResolvedValue(undefined);
  const openVerify = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue(true);
  const exportRoomKeys = over.exportRoomKeys ?? vi.fn(() => of('ARMORED'));
  const importRoomKeys = over.importRoomKeys ?? vi.fn(() => of(undefined));
  const prompt = over.prompt ?? vi.fn().mockResolvedValue('pw');
  const toastShow = vi.fn();
  const { fixture, container } = await render(SecuritySectionComponent, {
    providers: [
      MockProvider(CryptoService, {
        status: signal<CryptoStatus>(opts.status ?? 'ready').asReadonly(),
        keyBackupActive: signal(opts.backup ?? false).asReadonly(),
        thisDeviceVerified: signal(opts.verified ?? false).asReadonly(),
        refresh,
        exportRoomKeys,
        importRoomKeys,
      }),
      MockProvider(EncryptionDialogService, { openUnlock, openVerify }),
      MockProvider(TrnAlertService, { prompt }),
      MockProvider(TrnToastService, { show: toastShow }),
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
    exportRoomKeys,
    importRoomKeys,
    prompt,
    toastShow,
  };
}

/** A synthetic file-input change event carrying a text file (or none). jsdom's File
 * has no `.text()`, so stub just what onKeyFile reads. */
function fileEvent(text?: string): Event {
  const files =
    text === undefined ? [] : [{ text: () => Promise.resolve(text) }];
  return { target: { files, value: '' } } as unknown as Event;
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

  it('offers the lost-key escape hatch, arriving with the reset offered', async () => {
    // Same screen as "Enter recovery key" — one implementation of an irreversible flow —
    // but it must not dump the user there to hunt for the same words a second time.
    const { container, openUnlock } = await build({ status: 'needs-recovery' });
    const lost = container.querySelector<HTMLButtonElement>(
      '[data-testid=security-reset-recovery]',
    );
    expect(lost).not.toBeNull();

    lost?.click();

    expect(openUnlock).toHaveBeenCalledWith({
      returnTo: '/settings/security',
      offerReset: true,
    });
  });

  it('shows the secured state when encryption is ready (no fix action)', async () => {
    const { container } = await build({ status: 'ready' });
    expect(container.textContent).toContain('secured with end-to-end');
    expect(container.querySelector('[data-testid=security-setup]')).toBeNull();
    expect(container.querySelector('[data-testid=security-unlock]')).toBeNull();
    expect(
      container.querySelector('[data-testid=security-reset-recovery]'),
    ).toBeNull();
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

  it('exports room keys with the entered passphrase and toasts', async () => {
    const { cmp, exportRoomKeys, prompt, toastShow } = await build();

    await cmp.exportKeys();

    expect(prompt).toHaveBeenCalled();
    expect(exportRoomKeys).toHaveBeenCalledWith('pw');
    expect(toastShow).toHaveBeenCalledWith(
      'Room keys exported.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('does not export when the passphrase prompt is cancelled', async () => {
    const prompt = vi.fn().mockResolvedValue(null);
    const { cmp, exportRoomKeys } = await build({}, { prompt });

    await cmp.exportKeys();

    expect(exportRoomKeys).not.toHaveBeenCalled();
  });

  it('imports room keys from the picked file with its passphrase', async () => {
    const { cmp, importRoomKeys, toastShow } = await build();

    await cmp.onKeyFile(fileEvent('ARMORED-FILE'));

    expect(importRoomKeys).toHaveBeenCalledWith('ARMORED-FILE', 'pw');
    expect(toastShow).toHaveBeenCalledWith(
      'Room keys imported.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('does nothing when no file is picked', async () => {
    const { cmp, importRoomKeys } = await build();

    await cmp.onKeyFile(fileEvent(undefined));

    expect(importRoomKeys).not.toHaveBeenCalled();
  });

  it('surfaces an import failure (e.g. wrong passphrase) as a toast', async () => {
    const importRoomKeys = vi.fn(() =>
      throwError(
        () => new Error('Incorrect passphrase, or the key file is corrupted.'),
      ),
    );
    const { cmp, toastShow } = await build({}, { importRoomKeys });

    await cmp.onKeyFile(fileEvent('ARMORED-FILE'));

    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Incorrect passphrase'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});
