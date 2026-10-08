import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SystemStatusVisibilityService } from './system-status-visibility.service';

describe('SystemStatusVisibilityService', () => {
  it('holds whether System status is open', () => {
    const service = TestBed.inject(SystemStatusVisibilityService);

    service.show();
    expect(service.open()).toBe(true);
    service.close();
    expect(service.open()).toBe(false);
  });
});
