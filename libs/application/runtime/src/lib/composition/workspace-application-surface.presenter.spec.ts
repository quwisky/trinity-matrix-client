import { Component, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  SETTINGS_DIALOG_COMPONENT,
  type EncryptionDialogLoaders,
} from '../application-dialog-loaders';
import {
  WorkspaceBackService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import {
  TrnDialogRef,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { firstValueFrom, of, Subject, type Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';

@Component({ template: '' })
class StubSettingsComponent {}
@Component({ template: '' })
class StubUnlockComponent {}
@Component({ template: '' })
class StubVerifyComponent {}

describe('Workspace application-surface composition adapter', () => {
  const events = new Subject<NavigationStart>();
  const navigate = vi.fn().mockResolvedValue(true);
  const dialogOpen = vi.fn();
  const close = vi.fn();
  let lifetime: Subscription;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    dialogOpen.mockReturnValue(
      new TrnDialogRef({ closed: new Subject(), close }),
    );
    TestBed.configureTestingModule({
      providers: [
        WorkspaceApplicationSurfacePresenterAdapter,
        { provide: Router, useValue: { navigate, events } },
        {
          provide: TrnDialogService,
          useValue: { open: dialogOpen, isTopmost: vi.fn(() => true) },
        },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
        {
          provide: ENCRYPTION_DIALOG_COMPONENTS,
          useValue: {
            unlock: () => of(StubUnlockComponent as Type<unknown>),
            verify: () => of(StubVerifyComponent as Type<unknown>),
          } satisfies EncryptionDialogLoaders,
        },
        {
          provide: SETTINGS_DIALOG_COMPONENT,
          useValue: () => of(StubSettingsComponent as Type<unknown>),
        },
      ],
    });
    lifetime = TestBed.inject(WorkspaceApplicationSurfacePresenterAdapter)
      .run()
      .subscribe();
  });

  afterEach(() => {
    lifetime.unsubscribe();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function presenter() {
    return TestBed.inject(WorkspaceApplicationSurfacePresenterAdapter);
  }

  it('keeps routed presentation cold and maps semantic return destinations at the adapter', async () => {
    const request = {
      surface: { kind: 'trust', flow: 'setup' },
      context: { returnTo: { kind: 'settings', section: 'security' } },
    } as const satisfies WorkspaceApplicationSurfaceRequest;
    const command = presenter().present(request);

    expect(navigate).not.toHaveBeenCalled();
    await firstValueFrom(command);

    expect(navigate).toHaveBeenCalledWith(['/encryption/setup'], {
      queryParams: { returnTo: '/settings/security' },
    });
  });

  it('maps a routed recovery reset intent to the canonical query parameter', async () => {
    await firstValueFrom(
      presenter().present({
        surface: { kind: 'trust', flow: 'unlock' },
        context: { offerReset: true },
      }),
    );

    expect(navigate).toHaveBeenCalledWith(['/encryption/unlock'], {
      queryParams: { reset: '1' },
    });
  });

  it('registers a modal Settings identity with Workspace Back', async () => {
    const request = {
      surface: { kind: 'settings', section: 'stickers' },
      context: { sourceRoomId: '!room:example.org' },
    } as const satisfies WorkspaceApplicationSurfaceRequest;

    await firstValueFrom(presenter().present(request));

    expect(dialogOpen).toHaveBeenCalledWith(StubSettingsComponent, {
      inputs: {
        initialSection: 'stickers',
        initialSource: '!room:example.org',
      },
      ariaLabel: 'Settings',
      autoFocus: '[data-settings-autofocus]',
    });
    await expect(
      firstValueFrom(TestBed.inject(WorkspaceBackService).back()),
    ).resolves.toMatchObject({
      kind: 'dismissed',
      surface: { layer: 'application', surface: request.surface },
    });
    expect(close).toHaveBeenCalled();
  });

  it('keeps Settings routed in installed Capacitor hosts', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    await firstValueFrom(
      presenter().present({
        surface: { kind: 'settings', section: 'security' },
      }),
    );

    expect(navigate).toHaveBeenCalledWith(['/settings/security'], {});
    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('opens a nested trust flow over modal Settings and makes it the active surface', async () => {
    const settingsClosed = new Subject<void>();
    const trustClosed = new Subject<void>();
    const settingsClose = vi.fn(() => {
      settingsClosed.next();
      settingsClosed.complete();
    });
    const trustClose = vi.fn(() => {
      trustClosed.next();
      trustClosed.complete();
    });
    const settingsRef = new TrnDialogRef({
      closed: settingsClosed,
      close: settingsClose,
    });
    const trustRef = new TrnDialogRef({
      closed: trustClosed,
      close: trustClose,
    });
    dialogOpen.mockReturnValueOnce(settingsRef).mockReturnValueOnce(trustRef);
    await firstValueFrom(
      presenter().present({
        surface: { kind: 'settings', section: 'security' },
      }),
    );
    await firstValueFrom(
      presenter().present({
        surface: { kind: 'trust', flow: 'verify' },
        context: { placement: 'nested' },
      }),
    );

    expect(dialogOpen).toHaveBeenNthCalledWith(2, StubVerifyComponent, {
      inputs: { asModal: true },
      disableClose: true,
      ariaLabel: 'Encryption',
    });
    await expect(
      firstValueFrom(TestBed.inject(WorkspaceBackService).back()),
    ).resolves.toMatchObject({
      kind: 'blocked',
      surface: {
        layer: 'application',
        surface: { kind: 'trust', flow: 'verify' },
      },
    });
    trustRef.close();
    await expect(
      firstValueFrom(TestBed.inject(WorkspaceBackService).back()),
    ).resolves.toMatchObject({
      kind: 'dismissed',
      surface: {
        layer: 'application',
        surface: { kind: 'settings', section: 'security' },
      },
    });
    expect(settingsClose).toHaveBeenCalledOnce();
  });

  it('keeps a flow-critical trust dialog blocked while local overlays can sit above it', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );

    await firstValueFrom(
      presenter().present({ surface: { kind: 'trust', flow: 'verify' } }),
    );

    expect(dialogOpen).toHaveBeenCalledWith(StubVerifyComponent, {
      inputs: { asModal: true },
      disableClose: true,
      ariaLabel: 'Encryption',
    });
    await expect(
      firstValueFrom(TestBed.inject(WorkspaceBackService).back()),
    ).resolves.toMatchObject({ kind: 'blocked' });
    expect(close).not.toHaveBeenCalled();
  });
});
