import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { injectHostAppName } from './host-app-name';
import { HostAuthenticationHandoffService } from './host-operation.services';

function appNameWith(deviceDisplayName?: () => string): string {
  TestBed.configureTestingModule({
    providers: deviceDisplayName
      ? [
          {
            provide: HostAuthenticationHandoffService,
            useValue: { deviceDisplayName },
          },
        ]
      : [],
  });
  return TestBed.runInInjectionContext(() => injectHostAppName());
}

describe('injectHostAppName', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names the app as the host does', () => {
    expect(appNameWith(() => 'Trinity Next')).toBe('Trinity Next');
  });

  it('is Trinity without a host name of its own', () => {
    expect(appNameWith()).toBe('Trinity');
    TestBed.resetTestingModule();
    expect(appNameWith(() => '')).toBe('Trinity');
  });

  it('is Trinity when the desktop shell reported no identity', () => {
    expect(
      appNameWith(() => {
        throw new Error('The desktop shell did not report its app identity.');
      }),
    ).toBe('Trinity');
  });
});
