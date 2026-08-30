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
  let service: NavigationFocusService;

  beforeEach(() => {
    events = new Subject<RouterEvent>();
    TestBed.configureTestingModule({
      providers: [MockProvider(Router, { events })],
    });
    service = TestBed.inject(NavigationFocusService);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function mountPage(html: string): void {
    document.body.innerHTML = `<router-outlet></router-outlet>${html}`;
  }

  it('focuses only after NavigationEnd while Application Runtime owns the stream', () => {
    mountPage('<div><h1>Rooms</h1></div>');
    const focus = vi.spyOn(service, 'focusEnteringPage');
    const lifetime = service.run().subscribe();

    events.next(new NavigationStart(1, '/rooms'));
    expect(focus).not.toHaveBeenCalled();
    events.next(new NavigationEnd(1, '/rooms', '/rooms'));

    expect(focus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(document.querySelector('h1'));
    lifetime.unsubscribe();
  });

  it('prefers a feature-owned focus target and safely handles an empty outlet', () => {
    mountPage(
      '<div><h1>Settings</h1><h2 data-route-focus>Appearance</h2></div>',
    );
    service.focusEnteringPage();
    expect(document.activeElement).toBe(
      document.querySelector('[data-route-focus]'),
    );

    document.body.innerHTML = '<router-outlet></router-outlet>';
    expect(() => service.focusEnteringPage()).not.toThrow();
  });

  it('cancels pending focus work when the runtime session stops', () => {
    const frames = new Map<number, FrameRequestCallback>();
    const cancel = vi.fn((frameId: number) => frames.delete(frameId));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(7, callback);
      return 7;
    });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const focus = vi.spyOn(service, 'focusEnteringPage');
    const lifetime = service.run().subscribe();

    events.next(new NavigationEnd(1, '/rooms', '/rooms'));
    lifetime.unsubscribe();
    frames.get(7)?.(0);

    expect(cancel).toHaveBeenCalledWith(7);
    expect(focus).not.toHaveBeenCalled();
  });
});
