import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SystemStatusVisibilityService } from './system-status-visibility.service';

describe('SystemStatusVisibilityService', () => {
  it('uses an explicit restore callback and preserves the original target', async () => {
    const service = TestBed.inject(SystemStatusVisibilityService);
    const restore = document.createElement('button');
    document.body.append(restore);
    let restores = 0;

    service.show(() => {
      restores += 1;
      restore.focus();
    });
    service.show(() => {
      restores += 100;
    });
    service.close();
    await Promise.resolve();

    expect(restores).toBe(1);
    expect(document.activeElement).toBe(restore);
    restore.remove();
  });

  it('captures the focused element when no explicit restore callback is supplied', async () => {
    const service = TestBed.inject(SystemStatusVisibilityService);
    const origin = document.createElement('button');
    document.body.append(origin);
    origin.focus();

    service.show();
    service.close();
    await Promise.resolve();

    expect(document.activeElement).toBe(origin);
    origin.remove();
  });
});
