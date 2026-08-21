import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackInterceptorService } from './back-interceptor.service';

describe('BackInterceptorService', () => {
  let service: BackInterceptorService;

  beforeEach(() => {
    service = TestBed.configureTestingModule({}).inject(BackInterceptorService);
  });

  it('says nothing was handled when nothing is registered', () => {
    // The default has to be false, or Back would stop leaving the page at all.
    expect(service.handle()).toBe(false);
  });

  it('asks the most recent first, and stops at the one that handles it', () => {
    // "Back" means the most recent thing, so the stack unwinds from the top.
    const order: string[] = [];
    service.register(() => {
      order.push('first');
      return true;
    });
    service.register(() => {
      order.push('second');
      return true;
    });

    expect(service.handle()).toBe(true);
    expect(order).toEqual(['second']);
  });

  it('falls through an interceptor that declines', () => {
    const first = vi.fn(() => true);
    service.register(first);
    service.register(() => false);

    expect(service.handle()).toBe(true);
    expect(first).toHaveBeenCalled();
  });

  it('reports unhandled when every interceptor declines', () => {
    service.register(() => false);
    service.register(() => false);

    expect(service.handle()).toBe(false);
  });

  it('stops asking one that has unregistered', () => {
    // The case that matters: a page destroyed with a panel open must not leave a handler
    // behind that closes something no longer on screen.
    const gone = vi.fn(() => true);
    const remove = service.register(gone);

    remove();

    expect(service.handle()).toBe(false);
    expect(gone).not.toHaveBeenCalled();
  });

  it('survives an interceptor that unregisters itself while handling', () => {
    // The normal case, not an edge one: closing the last panel means there is nothing left
    // to intercept, so the handler tears itself down mid-loop. Iterating the live array
    // would skip its neighbour.
    const below = vi.fn(() => true);
    service.register(below);
    let remove = () => undefined as void;
    remove = service.register(() => {
      remove();
      return false; // declined, so the one below must still be asked
    });

    expect(service.handle()).toBe(true);
    expect(below).toHaveBeenCalled();
  });

  it('counts what is registered, so a caller can tell without reaching inside', () => {
    expect(service.count()).toBe(0);
    const remove = service.register(() => false);
    expect(service.count()).toBe(1);

    remove();
    expect(service.count()).toBe(0);
    // Removing twice must not go negative or drop somebody else's registration.
    remove();
    expect(service.count()).toBe(0);
  });
});
