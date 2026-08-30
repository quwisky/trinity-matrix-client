import { signal } from '@angular/core';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { TrustService, type TrustStatus } from '@trinity/data-access/trust';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { SecuritySectionComponent } from './security-section.component';

async function build(
  opts: {
    status?: TrustStatus;
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
  const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
    of({ kind: 'presented' as const, surface: request.surface }),
  );
  const exportRoomKeys = over.exportRoomKeys ?? vi.fn(() => of('ARMORED'));
  const importRoomKeys = over.importRoomKeys ?? vi.fn(() => of(undefined));
  const prompt = over.prompt ?? vi.fn().mockResolvedValue('pw');
  const toastShow = vi.fn();
  const { fixture, container } = await render(SecuritySectionComponent, {
    providers: [
      MockProvider(TrustService, {
        status: signal<TrustStatus>(opts.status ?? 'ready').asReadonly(),
        keyBackupActive: signal(opts.backup ?? false).asReadonly(),
        thisDeviceVerified: signal(opts.verified ?? false).asReadonly(),
        refresh,
        exportRoomKeys,
        importRoomKeys,
      }),
      MockProvider(WorkspaceApplicationSurfaceService, { open }),
      MockProvider(TrnAlertService, { prompt }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    fixture,
    cmp: fixture.componentInstance,
    container,
    refresh,
    open,
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
