import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TrnDialogRef, TrnDialogService } from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialogService } from './settings-dialog.service';
import {
  SETTINGS_DIALOG_CONFIG,
  type SettingsDialogConfig,
} from './settings-dialog.tokens';

@Component({ selector: 'trn-stub-settings', template: '' })
class StubSettingsDialogComponent {}

function setup(config?: Partial<SettingsDialogConfig>) {
  const closed = new Subject<unknown>();
  const ref = new TrnDialogRef({ closed, close: vi.fn() });
  const value = {
    load: vi.fn().mockResolvedValue(StubSettingsDialogComponent),
    shouldPresentAsDialog: vi.fn().mockReturnValue(true),
    ...config,
  } satisfies SettingsDialogConfig;
  TestBed.configureTestingModule({
    providers: [
      SettingsDialogService,
      MockProvider(Router),
      MockProvider(TrnDialogService, { open: vi.fn().mockReturnValue(ref) }),
      { provide: SETTINGS_DIALOG_CONFIG, useValue: value },
    ],
  });
  return {
    service: TestBed.inject(SettingsDialogService),
    router: TestBed.inject(Router),
    dialog: TestBed.inject(TrnDialogService),
    config: value,
    closed,
  };
}

describe('SettingsDialogService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('opens one named modal without changing routes on web or Electron', async () => {
    const { service, dialog, router } = setup();

    await service.open({ section: 'notifications' });

    expect(dialog.open).toHaveBeenCalledWith(StubSettingsDialogComponent, {
      inputs: { initialSection: 'notifications' },
      ariaLabel: 'Settings',
      autoFocus: '[data-settings-autofocus]',
    });
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('uses the routed flow on Android and iOS', async () => {
    const { service, dialog, router } = setup({
      shouldPresentAsDialog: () => false,
    });

    await service.open({ section: 'stickers', roomId: '!room:example.org' });

    expect(dialog.open).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/settings', 'stickers'], {
      queryParams: { roomId: '!room:example.org' },
    });
  });

  it('coalesces repeated opens while the feature is loading', async () => {
    let resolve!: (component: typeof StubSettingsDialogComponent) => void;
    const loading = new Promise<typeof StubSettingsDialogComponent>((done) => {
      resolve = done;
    });
    const { service, dialog } = setup({ load: () => loading });

    const first = service.open();
    const second = service.open();
    resolve(StubSettingsDialogComponent);
    await Promise.all([first, second]);

    expect(dialog.open).toHaveBeenCalledTimes(1);
  });

  it('allows another dialog after close and restores a logical owner', async () => {
    const restoreFocus = vi.fn();
    const { service, dialog, closed } = setup();

    await service.open({ restoreFocus });
    await service.open();
    expect(dialog.open).toHaveBeenCalledTimes(1);

    closed.next(undefined);
    closed.complete();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it('falls back to the deep-link route when lazy loading fails', async () => {
    const { service, router } = setup({
      load: () => Promise.reject(new Error('chunk unavailable')),
    });

    await service.open({ section: 'security' });

    expect(router.navigate).toHaveBeenCalledWith(['/settings', 'security'], {});
  });
});
