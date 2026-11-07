import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HostLifecycleService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { HiddenWindowAnimations } from './hidden-window-animations.service';

describe('HiddenWindowAnimations', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks the root while the window is hidden, and unmarks it when it ends', () => {
    const events = new Subject<{ readonly kind: 'active' | 'background' }>();
    TestBed.configureTestingModule({
      providers: [MockProvider(HostLifecycleService, { events })],
    });
    const root = TestBed.inject(DOCUMENT).documentElement;
    const lifetime = TestBed.inject(HiddenWindowAnimations).run().subscribe();
    expect(root.hasAttribute('data-window-hidden')).toBe(false);

    events.next({ kind: 'background' });
    expect(root.hasAttribute('data-window-hidden')).toBe(true);

    events.next({ kind: 'active' });
    expect(root.hasAttribute('data-window-hidden')).toBe(false);

    events.next({ kind: 'background' });
    lifetime.unsubscribe();
    expect(root.hasAttribute('data-window-hidden')).toBe(false);
  });
});
