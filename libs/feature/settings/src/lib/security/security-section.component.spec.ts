import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  TrustService,
  type TrustHealth,
  type TrustStatus,
} from '@trinity/data-access/trust';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  HostFileExportService,
  HostSystemUiService,
} from '@trinity/runtime/host';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  SecureStorageService,
  StoragePersistenceService,
} from '@trinity/platform-native';
import { SecuritySectionComponent } from './security-section.component';

async function build(
  opts: {
    status?: TrustStatus;
    verified?: boolean;
    backup?: boolean;
    availability?: TrustHealth['availability'];
    cryptoStoreEncrypted?: boolean | null;
    identityElsewhere?: boolean;
    unprotected?: boolean;
    persistenceOffered?: boolean;
    spaceLow?: boolean;
  } = {},
  over: {
    exportRoomKeys?: Mock;
    importRoomKeys?: Mock;
    prompt?: Mock;
    fileSave?: Mock;
  } = {},
) {
  const snapshot = {
    status: opts.status === 'unknown' ? 'ready' : (opts.status ?? 'ready'),
    keyBackupActive: opts.backup ?? false,
    thisDeviceVerified: opts.verified ?? false,
    identityElsewhere: opts.identityElsewhere ?? false,
  } as const;
  const health: TrustHealth =
    opts.availability === 'unavailable'
      ? { availability: 'unavailable', current: null, stale: null }
      : opts.availability === 'stale'
        ? { availability: 'stale', current: null, stale: snapshot }
        : { availability: 'coherent', current: snapshot, stale: null };
  const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
    of({ kind: 'presented' as const, surface: request.surface }),
  );
  const exportRoomKeys = over.exportRoomKeys ?? vi.fn(() => of('ARMORED'));
  const importRoomKeys = over.importRoomKeys ?? vi.fn(() => of(undefined));
  const prompt = over.prompt ?? vi.fn(() => of('pw'));
  const toastShow = vi.fn();
  const fileSave =
    over.fileSave ?? vi.fn(() => of({ kind: 'completed' as const }));
  const { fixture, container } = await render(SecuritySectionComponent, {
    providers: [
      MockProvider(TrustService, {
        health: signal(health).asReadonly(),
        status: signal<TrustStatus>(
          health.current?.status ?? 'unknown',
        ).asReadonly(),
        keyBackupActive: signal(
          health.current?.keyBackupActive ?? null,
        ).asReadonly(),
        thisDeviceVerified: signal(
          health.current?.thisDeviceVerified ?? null,
        ).asReadonly(),
        recoverySetupElsewhere: signal(
          health.current?.status === 'needs-setup' &&
            health.current.thisDeviceVerified &&
            health.current.identityElsewhere,
        ).asReadonly(),
        exportRoomKeys,
        importRoomKeys,
      }),
      MockProvider(WorkspaceApplicationSurfaceService, { open }),
      MockProvider(TrnAlertService, { prompt$: prompt }),
      MockProvider(TrnToastService, { show: toastShow }),
      MockProvider(HostFileExportService, { save: fileSave }),
      MockProvider(SecureStorageService, {
        storesUnprotectedSecrets: vi.fn(() =>
          Promise.resolve(opts.unprotected ?? false),
        ),
      }),
      MockProvider(StoragePersistenceService, {
        offered: () => opts.persistenceOffered ?? true,
        spaceLow: () => Promise.resolve(opts.spaceLow ?? false),
      }),
      MockProvider(MatrixClientService, {
        cryptoStoreEncrypted: signal(
          opts.cryptoStoreEncrypted ?? true,
        ).asReadonly(),
      }),
    ],
  });
  return {
    fixture,
    cmp: fixture.componentInstance,
    container,
    open,
    exportRoomKeys,
    importRoomKeys,
    prompt,
    toastShow,
    fileSave,
  };
}

/** A synthetic file-input change event carrying a text file (or none). jsdom's File
 * has no `.text()`, so stub just what onKeyFile reads. */
function fileEvent(text?: string): Event {
  const files =
    text === undefined ? [] : [{ text: () => Promise.resolve(text) }];
  return { target: { files, value: '' } } as unknown as Event;
}

/** Click a control by its test id, as the user would. */
function click(container: Element, testId: string): void {
  const button = container.querySelector<HTMLElement>(
    `[data-testid=${testId}]`,
  );
  expect(button).not.toBeNull();
  button?.click();
}

describe('SecuritySectionComponent', () => {
  it('counts the room key file chooser as Trinity’s own system UI while it is open', async () => {
    const { container } = await build();
    const ui = TestBed.inject(HostSystemUiService);
    const input = container.querySelector<HTMLInputElement>(
      'input[type=file]',
    ) as HTMLInputElement;
    input.click();
    expect(ui.active()).toBe(true);
    input.dispatchEvent(new Event('cancel'));
    expect(ui.active()).toBe(false);
  });

  it('offers verification and an explicit reset when the identity lives elsewhere', async () => {
    const { container, open } = await build({
      status: 'needs-verification',
    });

    expect(
      container.querySelector('[data-testid=security-needs-verification]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid=security-setup]')).toBeNull();
    // One label per action, the same words the rooms banner uses.
    expect(
      container
        .querySelector('[data-testid=security-verify-device]')
        ?.textContent?.trim(),
    ).toBe('Verify with another device');
    expect(
      container
        .querySelector('[data-testid=security-reset-identity]')
        ?.textContent?.trim(),
    ).toBe('Reset my identity');
    // The card leads with the verify action; the session group must not repeat it.
    expect(
      [...container.querySelectorAll('button')].filter(
        (b) => b.textContent?.trim() === 'Verify with another device',
      ),
    ).toHaveLength(1);
    expect(container.querySelector('[data-testid=security-verify]')).toBeNull();
    expect(
      container.querySelector('[data-testid=security-session]')?.textContent,
    ).toContain('This session isn’t verified yet.');

    click(container, 'security-verify-device');
    expect(open).toHaveBeenLastCalledWith({
      surface: { kind: 'trust', flow: 'verify' },
      context: { returnTo: { kind: 'settings', section: 'security' } },
    });

    click(container, 'security-reset-identity');
    expect(open).toHaveBeenLastCalledWith({
      surface: { kind: 'trust', flow: 'unlock' },
      context: {
        returnTo: { kind: 'settings', section: 'security' },
        offerReset: true,
      },
    });
  });

  it('points a verified device without the keys to the other device instead of setup', async () => {
    const { container, open } = await build({
      status: 'needs-setup',
      verified: true,
      identityElsewhere: true,
    });

    expect(
      container.querySelector('[data-testid=security-setup-elsewhere]')
        ?.textContent,
    ).toContain(
      'Set up recovery on the device where you first set up encryption.',
    );
    expect(container.querySelector('[data-testid=security-setup]')).toBeNull();

    click(container, 'security-reset-identity');
    expect(open).toHaveBeenLastCalledWith({
      surface: { kind: 'trust', flow: 'unlock' },
      context: {
        returnTo: { kind: 'settings', section: 'security' },
        offerReset: true,
      },
    });
  });

  it('offers setup when encryption needs setting up', async () => {
    const { container, cmp, open } = await build({ status: 'needs-setup' });
    expect(
      container.querySelector('[data-testid=security-setup]'),
    ).not.toBeNull();

    cmp.setUp();

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'setup' },
      context: {
        returnTo: { kind: 'settings', section: 'security' },
      },
    });
  });

  it('offers recovery-key unlock when this device needs recovery', async () => {
    const { container, cmp, open } = await build({
      status: 'needs-recovery',
    });
    expect(
      container.querySelector('[data-testid=security-unlock]'),
    ).not.toBeNull();

    cmp.unlock();

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'unlock' },
      context: {
        returnTo: { kind: 'settings', section: 'security' },
      },
    });
  });

  it('offers the lost-key escape hatch, arriving with the reset offered', async () => {
    // Same screen as "Enter recovery key" — one implementation of an irreversible flow —
    // but it must not dump the user there to hunt for the same words a second time.
    const { container, open } = await build({ status: 'needs-recovery' });
    const lost = container.querySelector<HTMLButtonElement>(
      '[data-testid=security-reset-recovery]',
    );
    expect(lost).not.toBeNull();
    // A quiet door to the same reset as "Reset my identity", so it shares the danger tone.
    expect(lost?.getAttribute('variant')).toBe('danger');
    expect(lost?.getAttribute('presentation')).toBe('ghost');

    lost?.click();

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'unlock' },
      context: {
        returnTo: { kind: 'settings', section: 'security' },
        offerReset: true,
      },
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
    const { container, cmp, open } = await build({ verified: false });
    expect(
      container.querySelector('[data-testid=security-verify]'),
    ).not.toBeNull();

    cmp.verifySession();

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'verify' },
      context: {
        returnTo: { kind: 'settings', section: 'security' },
      },
    });
  });

  it('keeps nested verification modal and returns to the current room', async () => {
    const { fixture, cmp, open } = await build({ verified: false });
    fixture.componentRef.setInput('inSettingsDialog', true);
    fixture.detectChanges();

    cmp.verifySession();

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: { kind: 'trust', flow: 'verify' },
        context: expect.objectContaining({
          returnTo: { kind: 'settings', section: 'security' },
          placement: 'nested',
          ownerActive: expect.any(Function),
        }),
      }),
    );
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

  it('reflects key backup being off and offers recovery setup', async () => {
    const { container } = await build({ status: 'needs-setup', backup: false });
    expect(
      container.querySelector('[data-testid=security-backup]')?.textContent,
    ).toContain(
      'Key backup is off — set up recovery to back up your message keys.',
    );
  });

  it('points key backup to the original device when the identity lives elsewhere', async () => {
    const { container } = await build({
      status: 'needs-verification',
      backup: false,
    });
    const backup =
      container.querySelector('[data-testid=security-backup]')?.textContent ??
      '';
    expect(backup).toContain('Key backup is off.');
    expect(backup).toContain(
      'Set up recovery on the device where you first set up encryption.',
    );
    expect(backup).not.toContain('back up your message keys');
  });

  it('points key backup to the original device for a verified device without the keys', async () => {
    // needs-setup here only because the device is verified; setup would still replace
    // the identity the other device holds, so the backup line must not invite it.
    const { container } = await build({
      status: 'needs-setup',
      verified: true,
      identityElsewhere: true,
      backup: false,
    });
    const backup =
      container.querySelector('[data-testid=security-backup]')?.textContent ??
      '';
    expect(backup).toContain(
      'Set up recovery on the device where you first set up encryption.',
    );
    expect(backup).not.toContain('back up your message keys');
  });

  it('labels stale Trust and offers no actions that infer current state', async () => {
    const { container } = await build({
      status: 'needs-recovery',
      verified: false,
      backup: false,
      availability: 'stale',
    });

    expect(container.textContent).toContain(
      'last known status may be outdated',
    );
    expect(container.textContent).toContain(
      'Current session verification is unavailable',
    );
    expect(container.textContent).toContain(
      'Current key-backup status is unavailable',
    );
    expect(container.querySelector('[data-testid=security-unlock]')).toBeNull();
    expect(container.querySelector('[data-testid=security-verify]')).toBeNull();
  });

  it('asks to sign in again when this device keeps its keys in an unencrypted store', async () => {
    const { container } = await build({
      cryptoStoreEncrypted: false,
      backup: true,
    });

    const notice = container.querySelector(
      '[data-testid=security-stored-keys]',
    );
    expect(notice?.textContent).toContain(
      'Sign out and back in on this device to encrypt your stored keys',
    );
    // Signing out deletes this device's keys, so the notice points at the backup first.
    expect(notice?.textContent).toContain('recovery key');
    expect(notice?.textContent).not.toContain('Encrypted key export');
  });

  it('points to the key export before sign-out while key backup is off', async () => {
    const { container } = await build({
      cryptoStoreEncrypted: false,
      backup: false,
    });

    const text = (
      container.querySelector('[data-testid=security-stored-keys]')
        ?.textContent ?? ''
    ).toLowerCase();
    const signOut = text.indexOf(
      'sign out and back in on this device to encrypt your stored keys',
    );
    expect(signOut).toBeGreaterThan(-1);
    expect(text.indexOf('encrypted key export')).toBeGreaterThan(-1);
    expect(text.indexOf('encrypted key export')).toBeLessThan(signOut);
  });

  it.each([true, null])(
    'shows no stored-keys notice when the store is encrypted or unknown (%s)',
    async (cryptoStoreEncrypted) => {
      const { container } = await build({ cryptoStoreEncrypted });

      expect(
        container.querySelector('[data-testid=security-stored-keys]'),
      ).toBeNull();
    },
  );

  it.each([true, false])(
    'warns for as long as secrets are stored without a keyring (%s)',
    async (unprotected) => {
      const { fixture, container } = await build({ unprotected });
      await fixture.whenStable();
      fixture.detectChanges();

      const warning = container.querySelector(
        '[data-testid=security-no-keyring]',
      );
      if (unprotected) {
        expect(warning?.textContent).toContain('stored unprotected on disk');
      } else {
        expect(warning).toBeNull();
      }
    },
  );

  it.each([
    [false, true, 'Your recovery key restores your encrypted messages.'],
    [false, false, 'Set up recovery so you can restore them.'],
  ])(
    'explains where iOS may clear local data (offered %s, backup %s)',
    async (persistenceOffered, backup, advice) => {
      const { container } = await build({ persistenceOffered, backup });

      const note = container.querySelector('[data-testid=security-local-data]');
      expect(note?.textContent).toContain(
        'iOS can clear Trinity’s local data if your phone runs very low on space.',
      );
      expect(note?.textContent).toContain(advice);
    },
  );

  it('gives no recovery advice while backup status is unknown', async () => {
    const { container } = await build({
      persistenceOffered: false,
      availability: 'unavailable',
    });

    const note = container.querySelector('[data-testid=security-local-data]');
    expect(note?.textContent).toContain('iOS can clear Trinity’s local data');
    expect(note?.textContent).not.toContain('recovery');
  });

  it('says nothing about local data where storage can be kept', async () => {
    const { container } = await build({ persistenceOffered: true });

    expect(
      container.querySelector('[data-testid=security-local-data]'),
    ).toBeNull();
  });

  it.each([true, false])(
    'warns on any platform while the device is low on space (%s)',
    async (spaceLow) => {
      const { fixture, container } = await build({ spaceLow });
      await fixture.whenStable();
      fixture.detectChanges();

      const note = container.querySelector('[data-testid=security-low-space]');
      if (spaceLow) {
        expect(note?.textContent).toContain('Free up space on this device');
      } else {
        expect(note).toBeNull();
      }
    },
  );

  it('exports room keys with the entered passphrase and toasts', async () => {
    const { cmp, exportRoomKeys, prompt, toastShow, fileSave } = await build();

    await cmp.exportKeys();

    expect(prompt).toHaveBeenCalled();
    expect(exportRoomKeys).toHaveBeenCalledWith('pw');
    expect(fileSave).toHaveBeenCalledWith({
      bytes: expect.any(Blob),
      filename: 'trinity-room-keys.txt',
    });
    const [{ bytes }] = fileSave.mock.calls[0] as [{ bytes: Blob }];
    await expect(bytes.text()).resolves.toBe('ARMORED');
    expect(toastShow).toHaveBeenCalledWith(
      'Room keys exported.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('reports an unavailable host file operation without claiming success', async () => {
    const fileSave = vi.fn(() =>
      of({ kind: 'unavailable', reason: 'not-supported' } as const),
    );
    const { cmp, toastShow } = await build({}, { fileSave });

    await cmp.exportKeys();

    expect(toastShow).toHaveBeenCalledWith(
      'Could not export your room keys.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('says nothing and clears the busy state when the user cancels the save', async () => {
    const fileSave = vi.fn(() => of({ kind: 'cancelled' } as const));
    const { cmp, toastShow } = await build({}, { fileSave });

    await cmp.exportKeys();

    expect(fileSave).toHaveBeenCalledOnce();
    expect(toastShow).not.toHaveBeenCalled();
    expect(cmp.busy()).toBe(false);
  });

  it('does not export when the passphrase prompt is cancelled', async () => {
    const prompt = vi.fn(() => of(null));
    const { cmp, exportRoomKeys } = await build({}, { prompt });

    await cmp.exportKeys();

    expect(exportRoomKeys).not.toHaveBeenCalled();
  });

  it('imports room keys from the picked file with its passphrase', async () => {
    const { cmp, importRoomKeys, toastShow } = await build();

    await cmp.onKeyFile(fileEvent('ARMORED-FILE'));

    await vi.waitFor(() =>
      expect(importRoomKeys).toHaveBeenCalledWith('ARMORED-FILE', 'pw'),
    );
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
      expect.objectContaining({ variant: 'danger' }),
    );
  });
});
