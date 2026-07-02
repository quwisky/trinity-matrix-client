import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { MatrixClientService, VerificationService } from '@trinity/core';
import { describe, expect, it, vi } from 'vitest';
import { AppComponent } from './app.component';

vi.mock('@capacitor/browser', () => ({
  Browser: { close: vi.fn().mockResolvedValue(undefined), open: vi.fn() },
}));

// AppComponent's template mounts <trn-verification-host>, which injects these.
// (It also injects TrnDialogService, but that's providedIn root and never opens a
// dialog here — active() stays null — so the real one is fine unprovided.)
const hostProviders = [
  { provide: MatrixClientService, useValue: { syncState: signal(null) } },
  {
    provide: VerificationService,
    useValue: { active: signal(null), connect: vi.fn() },
  },
];

describe('AppComponent', () => {
  it('should create the app', async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        provideServiceWorker('ngsw-worker.js', { enabled: false }),
        ...hostProviders,
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  describe('handleDeepLink', () => {
    async function create() {
      await TestBed.configureTestingModule({
        imports: [AppComponent],
        providers: [
          provideRouter([]),
          provideServiceWorker('ngsw-worker.js', { enabled: false }),
          ...hostProviders,
        ], // provideRouter powers <router-outlet>; hostProviders for trn-verification-host
      }).compileComponents();
      const cmp = TestBed.createComponent(AppComponent).componentInstance;
      const navigate = vi
        .spyOn(TestBed.inject(Router), 'navigate')
        .mockResolvedValue(true);
      return { cmp, navigate };
    }

    it('routes an sso-callback deep link to the callback page with token + state', async () => {
      const { cmp, navigate } = await create();

      cmp.handleDeepLink(
        'eu.qwky.trinity://sso-callback?loginToken=TOK&sso_state=NONCE',
      );

      expect(navigate).toHaveBeenCalledWith(['/sso-callback'], {
        queryParams: { loginToken: 'TOK', sso_state: 'NONCE' },
      });
    });

    it('ignores a deep link without a login token', async () => {
      const { cmp, navigate } = await create();
      cmp.handleDeepLink('eu.qwky.trinity://sso-callback');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('ignores an unrelated deep link', async () => {
      const { cmp, navigate } = await create();
      cmp.handleDeepLink('eu.qwky.trinity://elsewhere?loginToken=TOK');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('ignores a malformed URL', async () => {
      const { cmp, navigate } = await create();
      cmp.handleDeepLink('not a url');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('registers the Electron deep-link bridge and routes its URLs', async () => {
      let captured: ((url: string) => void) | undefined;
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
        isElectron: true,
        onDeepLink: (cb: (url: string) => void) => {
          captured = cb;
          return () => undefined;
        },
      };
      try {
        const { cmp, navigate } = await create();
        cmp.ngOnInit();

        expect(captured).toBeTypeOf('function');
        captured?.('eu.qwky.trinity://sso-callback?loginToken=TOK&sso_state=S');

        expect(navigate).toHaveBeenCalledWith(['/sso-callback'], {
          queryParams: { loginToken: 'TOK', sso_state: 'S' },
        });
      } finally {
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });
  });
});
