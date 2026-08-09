import { TestBed } from '@angular/core/testing';
import {
  NavigationEnd,
  NavigationStart,
  Router,
  type Event as RouterEvent,
} from '@angular/router';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationFocusService } from './navigation-focus.service';

describe('NavigationFocusService', () => {
  let events: Subject<RouterEvent>;
  let svc: NavigationFocusService;

  beforeEach(() => {
    events = new Subject<RouterEvent>();
    TestBed.configureTestingModule({
      providers: [MockProvider(Router, { events })],
    });
    svc = TestBed.inject(NavigationFocusService);
    // Run the deferred focus synchronously for deterministic assertions.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  /** The routed page renders as the sibling right after <router-outlet>. */
  function mountPage(html: string): void {
    document.body.innerHTML = `<router-outlet></router-outlet>${html}`;
  }

  describe('focusEnteringPage', () => {
    it('focuses the page heading ([role=heading] first) and makes it focusable', () => {
      mountPage(
        '<div><header><span role="heading">Settings</span></header><main>body</main></div>',
      );

      svc.focusEnteringPage();

      const heading = document.querySelector<HTMLElement>('[role="heading"]');
      expect(document.activeElement).toBe(heading);
      expect(heading?.tabIndex).toBe(-1);
    });

    it('falls back to <h1>, then <main>, then the page root', () => {
      mountPage('<section><h1>Home</h1></section>');
      svc.focusEnteringPage();
      expect(document.activeElement).toBe(document.querySelector('h1'));

      mountPage('<section><main>Body</main></section>');
      svc.focusEnteringPage();
      expect(document.activeElement).toBe(document.querySelector('main'));

      mountPage('<section id="root">no heading or main</section>');
      svc.focusEnteringPage();
      expect(document.activeElement).toBe(document.querySelector('#root'));
    });

    it('no-ops when there is no routed page after the outlet', () => {
      document.body.innerHTML = `<router-outlet></router-outlet>`;
      expect(() => svc.focusEnteringPage()).not.toThrow();
    });
  });

  describe('init', () => {
    it('focuses the entering page on NavigationEnd and ignores other events', () => {
      mountPage('<div><h1>Rooms</h1></div>');
      const spy = vi.spyOn(svc, 'focusEnteringPage');
      svc.init();

      events.next(new NavigationStart(1, '/rooms')); // not a NavigationEnd
      expect(spy).not.toHaveBeenCalled();

      events.next(new NavigationEnd(1, '/rooms', '/rooms'));

      expect(spy).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(document.querySelector('h1'));
    });
  });
});
