import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { CallStageService } from './call-stage.service';

describe('CallStageService', () => {
  it('keeps the video choice for one call id only', () => {
    const stage = TestBed.inject(CallStageService);
    expect(stage.videoChoice(1)).toBeNull();
    stage.setVideoChoice(1, false);
    expect(stage.videoChoice(1)).toBe(false);
    expect(stage.videoChoice(2)).toBeNull();
  });

  it('releases only its own registration', () => {
    const stage = TestBed.inject(CallStageService);
    const first = document.createElement('div');
    const second = document.createElement('div');

    const releaseFirst = stage.register(first);
    const releaseSecond = stage.register(second);
    releaseFirst();
    expect(stage.element()).toBe(second);

    releaseSecond();
    expect(stage.element()).toBeNull();
  });

  it('releases only its own dock registration', () => {
    const stage = TestBed.inject(CallStageService);
    const first = document.createElement('div');
    const second = document.createElement('div');

    const releaseFirst = stage.registerDock(first);
    const releaseSecond = stage.registerDock(second);
    releaseFirst();
    expect(stage.dockElement()).toBe(second);

    releaseSecond();
    expect(stage.dockElement()).toBeNull();
  });

  it('keeps the dock claimed when a stale claim is released', () => {
    const stage = TestBed.inject(CallStageService);
    expect(stage.dockPresent()).toBe(false);

    const releaseFirst = stage.claimDock();
    const releaseSecond = stage.claimDock();
    expect(stage.dockPresent()).toBe(true);
    releaseFirst();
    expect(stage.dockPresent()).toBe(true);

    releaseSecond();
    expect(stage.dockPresent()).toBe(false);
  });
});
