import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import { describe, expect, it, vi } from 'vitest';
import { roomTitle, TitleBarState } from './title-bar-state';

/** A host that names the app as the desktop prerelease does, or reports no identity. */
function provideHostAppName(deviceDisplayName: () => string): void {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: HostAuthenticationHandoffService,
        useValue: { deviceDisplayName },
      },
    ],
  });
}

describe('roomTitle', () => {
  it('formats the title row text', () => {
    expect(roomTitle('Trinity Dev', { name: 'general', isDirect: false })).toBe(
      'Trinity Dev · #general',
    );
    expect(roomTitle(null, { name: 'general', isDirect: false })).toBe(
      '#general',
    );
    expect(roomTitle(null, { name: 'Alice', isDirect: true })).toBe('Alice');
    expect(roomTitle('Trinity Dev', null)).toBeNull();
  });
});

describe('TitleBarState', () => {
  it('defaults to the app name with no switcher', () => {
    const state = TestBed.inject(TitleBarState);
    expect(state.title()).toBe('Trinity');
    expect(state.quickSwitcher()).toBeNull();
  });

  it('publishes and clears the context', () => {
    const state = TestBed.inject(TitleBarState);
    const open = vi.fn();
    state.setContext({ title: 'Trinity Dev · #general', quickSwitcher: open });
    expect(state.title()).toBe('Trinity Dev · #general');
    expect(state.quickSwitcher()).toBe(open);
    state.setContext(null);
    expect(state.title()).toBe('Trinity');
    expect(state.quickSwitcher()).toBeNull();
  });

  it('mirrors the title into document.title with the app name', () => {
    const state = TestBed.inject(TitleBarState);
    const title = TestBed.inject(Title);
    state.setContext({
      title: 'Trinity Dev · #general',
      quickSwitcher: vi.fn(),
    });
    TestBed.tick();
    expect(title.getTitle()).toBe('Trinity Dev · #general – Trinity');
    state.setContext(null);
    TestBed.tick();
    expect(title.getTitle()).toBe('Trinity');
  });

  it("uses the host's app name for the row and the window title", () => {
    provideHostAppName(() => 'Trinity Next');
    const state = TestBed.inject(TitleBarState);
    const title = TestBed.inject(Title);
    expect(state.appName).toBe('Trinity Next');
    TestBed.tick();
    expect(state.title()).toBe('Trinity Next');
    expect(title.getTitle()).toBe('Trinity Next');
    state.setContext({ title: '#general', quickSwitcher: vi.fn() });
    TestBed.tick();
    expect(title.getTitle()).toBe('#general – Trinity Next');
    state.setContext({ title: null, quickSwitcher: vi.fn() });
    TestBed.tick();
    expect(state.title()).toBe('Trinity Next');
    expect(title.getTitle()).toBe('Trinity Next');
  });

  it('falls back to "Trinity" when the desktop shell reports no identity', () => {
    provideHostAppName(() => {
      throw new Error('The desktop shell did not report its app identity.');
    });
    const state = TestBed.inject(TitleBarState);
    TestBed.tick();
    expect(state.title()).toBe('Trinity');
    expect(TestBed.inject(Title).getTitle()).toBe('Trinity');
  });
});
