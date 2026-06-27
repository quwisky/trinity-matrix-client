import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { AppComponent } from './app.component';

vi.mock('@capacitor/browser', () => ({
  Browser: { close: vi.fn().mockResolvedValue(undefined), open: vi.fn() },
}));

describe('AppComponent', () => {
  it('should create the app', async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  describe('handleDeepLink', () => {
    async function create() {
      await TestBed.configureTestingModule({
        imports: [AppComponent],
        providers: [provideRouter([])], // also supplies ActivatedRoute for IonRouterOutlet
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
  });
});
