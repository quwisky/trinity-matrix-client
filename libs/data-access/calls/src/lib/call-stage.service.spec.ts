import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { CallStageService } from './call-stage.service';

describe('CallStageService', () => {
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
});
