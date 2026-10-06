import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { describe, expect, it, vi } from 'vitest';
import { roomTitle, TitleBarState } from './title-bar-state';

describe('roomTitle', () => {
  it('formats the title row text', () => {
    expect(roomTitle('Trinity Dev', { name: 'general', isDirect: false })).toBe(
      'Trinity Dev · #general',
    );
    expect(roomTitle(null, { name: 'general', isDirect: false })).toBe(
      '#general',
    );
    expect(roomTitle(null, { name: 'Alice', isDirect: true })).toBe('Alice');
    expect(roomTitle('Trinity Dev', null)).toBe('Trinity');
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
});
