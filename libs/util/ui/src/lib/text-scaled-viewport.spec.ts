import { Component, DestroyRef, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textScaledViewportSignal } from './text-scaled-viewport';

@Component({ selector: 'trn-viewport-host', template: '' })
class ViewportHostComponent {
  readonly wide = textScaledViewportSignal(48, inject(DestroyRef));
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('font-size');
});

describe('text-scaled viewport', () => {
  it('switches navigation when text grows without a viewport resize', async () => {
    vi.stubGlobal('innerWidth', 900);
    document.documentElement.style.fontSize = '16px';
    const fixture = TestBed.createComponent(ViewportHostComponent);
    expect(fixture.componentInstance.wide()).toBe(true);
    document.documentElement.style.fontSize = '20px';
    await Promise.resolve();
    expect(fixture.componentInstance.wide()).toBe(false);
    document.documentElement.style.fontSize = '16px';
    await Promise.resolve();
    expect(fixture.componentInstance.wide()).toBe(true);
  });

  it('follows resizing and releases both update sources on destruction', async () => {
    vi.stubGlobal('innerWidth', 1000);
    document.documentElement.style.fontSize = '16px';
    const fixture = TestBed.createComponent(ViewportHostComponent);
    expect(fixture.componentInstance.wide()).toBe(true);
    vi.stubGlobal('innerWidth', 600);
    window.dispatchEvent(new Event('resize'));
    expect(fixture.componentInstance.wide()).toBe(false);
    fixture.destroy();
    vi.stubGlobal('innerWidth', 1600);
    window.dispatchEvent(new Event('resize'));
    document.documentElement.style.fontSize = '12px';
    await Promise.resolve();
    expect(fixture.componentInstance.wide()).toBe(false);
  });
});
