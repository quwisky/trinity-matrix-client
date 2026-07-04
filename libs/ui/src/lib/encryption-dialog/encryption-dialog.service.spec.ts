import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TrnDialogService } from '@trinity/helm/overlay';
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
  const open = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      EncryptionDialogService,
      { provide: Router, useValue: { navigate } },
      { provide: TrnDialogService, useValue: { open } },
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
  return { service, navigate, open };
}

describe('EncryptionDialogService', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('on the desktop split-pane layout', () => {
    beforeEach(() => stubViewport(true));

    it('opens unlock as a modal (asModal) and does not navigate', async () => {
      const { service, open, navigate } = setup();

      await service.openUnlock();

      expect(open).toHaveBeenCalledWith(StubUnlockPage, {
        inputs: { asModal: true },
        disableClose: true,
      });
      expect(navigate).not.toHaveBeenCalled();
    });

    it('opens verify as a modal with the verify component', async () => {
      const { service, open } = setup();

      await service.openVerify({ returnTo: '/settings' });

      expect(open).toHaveBeenCalledWith(
        StubVerifyPage,
        expect.objectContaining({ inputs: { asModal: true } }),
      );
    });

    it('falls back to routing when no loaders are wired', async () => {
      const { service, navigate, open } = setup({ loaders: null });

      await service.openVerify();

      expect(open).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/encryption/verify'], {});
    });
  });

  describe('on the mobile layout', () => {
    beforeEach(() => stubViewport(false));

    it('navigates to the unlock route instead of opening a modal', async () => {
      const { service, navigate, open } = setup();

      await service.openUnlock();

      expect(open).not.toHaveBeenCalled();
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
    const { service, navigate, open } = setup();

    await service.openUnlock();

    expect(open).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/encryption/unlock'], {});
  });
});
