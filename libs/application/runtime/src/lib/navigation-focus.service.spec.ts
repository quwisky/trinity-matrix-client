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
    document.body.innerHTML = html;
    document.body.firstElementChild?.classList.add('trn-routed-page');
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

    document.body.innerHTML = '';
    expect(() => service.focusEnteringPage()).not.toThrow();
  });

  // jsdom renders nothing, so a candidate in a hidden pane is modelled the way a
  // browser treats it: its focus() call is refused and activeElement stays put.
  function refuseFocus(element: Element | null): void {
    (element as HTMLElement).focus = () => undefined;
  }

  it('skips a heading the browser cannot focus, as in a hidden compact pane (#859)', () => {
    mountPage(
      '<section><div class="chat"><h1>Trinity</h1></div><main>Rooms</main></section>',
    );
    refuseFocus(document.querySelector('h1'));

    service.focusEnteringPage();

    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('falls back to the entering page when no candidate takes focus (#859)', () => {
    mountPage(
      '<trn-rooms><div class="chat"><h1>Trinity</h1></div></trn-rooms>',
    );
    refuseFocus(document.querySelector('h1'));

    service.focusEnteringPage();

    const page = document.querySelector<HTMLElement>('trn-rooms');
    expect(document.activeElement).toBe(page);
    expect(page?.tabIndex).toBe(-1);
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
