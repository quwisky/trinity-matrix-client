import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular/standalone';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptionDialogService } from './encryption-dialog.service';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogLoaders,
} from './encryption-dialog.tokens';

@Component({ selector: 'trn-stub-unlock', template: '' })
class StubUnlockPage {}
@Component({ selector: 'trn-stub-verify', template: '' })
class StubVerifyPage {}

/** Pretend the viewport is (or isn't) the desktop split-pane layout. */
function stubViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches }));
}

function setup(opts: { loaders?: EncryptionDialogLoaders | null } = {}) {
  const navigate = vi.fn().mockResolvedValue(true);
  const present = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockResolvedValue({ present });

  TestBed.configureTestingModule({
    providers: [
      EncryptionDialogService,
      { provide: Router, useValue: { navigate } },
      { provide: ModalController, useValue: { create } },
      ...(opts.loaders === undefined
        ? [
            {
              provide: ENCRYPTION_DIALOG_COMPONENTS,
              useValue: {
                unlock: () => Promise.resolve(StubUnlockPage),
                verify: () => Promise.resolve(StubVerifyPage),
              } satisfies EncryptionDialogLoaders,
            },
          ]
        : []),
    ],
  });
  const service = TestBed.inject(EncryptionDialogService);
  return { service, navigate, create, present };
}

describe('EncryptionDialogService', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('on the desktop split-pane layout', () => {
    beforeEach(() => stubViewport(true));

    it('opens unlock as a modal (asModal) and does not navigate', async () => {
      const { service, create, present, navigate } = setup();

      await service.openUnlock();

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          component: StubUnlockPage,
          componentProps: { asModal: true },
          backdropDismiss: false,
        }),
      );
      expect(present).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('opens verify as a modal with the verify component', async () => {
      const { service, create } = setup();

      await service.openVerify({ returnTo: '/settings' });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ component: StubVerifyPage }),
      );
    });

    it('falls back to routing when no loaders are wired', async () => {
      const { service, navigate, create } = setup({ loaders: null });

      await service.openVerify();

      expect(create).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/encryption/verify'], {});
    });
  });

  describe('on the mobile layout', () => {
    beforeEach(() => stubViewport(false));

    it('navigates to the unlock route instead of opening a modal', async () => {
      const { service, navigate, create } = setup();

      await service.openUnlock();

      expect(create).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/encryption/unlock'], {});
    });

    it('preserves returnTo as a query param when navigating to verify', async () => {
      const { service, navigate } = setup();

      await service.openVerify({ returnTo: '/settings' });

      expect(navigate).toHaveBeenCalledWith(['/encryption/verify'], {
        queryParams: { returnTo: '/settings' },
      });
    });
  });

  it('navigates when matchMedia is unavailable (non-DOM context)', async () => {
    vi.stubGlobal('matchMedia', undefined);
    const { service, navigate, create } = setup();

    await service.openUnlock();

    expect(create).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/encryption/unlock'], {});
  });
});
