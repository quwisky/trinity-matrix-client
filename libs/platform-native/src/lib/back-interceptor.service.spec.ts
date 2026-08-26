import { signal } from '@angular/core';
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
    expect(service.hasActive()).toBe(false);
  });

  it('asks the most recent first, and stops at the one that handles it', () => {
    // "Back" means the most recent thing, so the stack unwinds from the top.
    const order: string[] = [];
    service.register({
      active: () => true,
      dismiss: () => order.push('first'),
    });
    service.register({
      active: () => true,
      dismiss: () => order.push('second'),
    });

    expect(service.handle()).toBe(true);
    expect(order).toEqual(['second']);
  });

  it('skips inactive registrations and falls through to the newest active one', () => {
    const first = vi.fn();
    const inactive = vi.fn();
    service.register({ active: () => true, dismiss: first });
    service.register({ active: () => false, dismiss: inactive });

    expect(service.handle()).toBe(true);
    expect(first).toHaveBeenCalled();
    expect(inactive).not.toHaveBeenCalled();
  });

  it('reports unhandled when every registration is inactive', () => {
    service.register({ active: () => false, dismiss: vi.fn() });
    service.register({ active: () => false, dismiss: vi.fn() });

    expect(service.handle()).toBe(false);
    expect(service.hasActive()).toBe(false);
  });

  it('reacts when a registered surface opens and closes', () => {
    const active = signal(false);
    service.register({ active, dismiss: vi.fn() });

    expect(service.hasActive()).toBe(false);

    active.set(true);
    expect(service.hasActive()).toBe(true);

    active.set(false);
    expect(service.hasActive()).toBe(false);
  });

  it('stops asking one that has unregistered', () => {
    // The case that matters: a page destroyed with a panel open must not leave a handler
    // behind that closes something no longer on screen.
    const gone = vi.fn();
    const remove = service.register({ active: () => true, dismiss: gone });

    remove();

    expect(service.handle()).toBe(false);
    expect(service.hasActive()).toBe(false);
    expect(gone).not.toHaveBeenCalled();
  });

  it('survives a registration that removes itself while dismissing', () => {
    let remove = () => undefined as void;
    const dismiss = vi.fn(() => remove());
    remove = service.register({
      active: () => true,
      dismiss,
    });

    expect(service.handle()).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(service.hasActive()).toBe(false);
  });

  it('tolerates a removal called twice, without dropping somebody else', () => {
    // Two pages mid-transition can both hold a registration, and a destroy hook is not
    // guaranteed to run once — a second removal must be a no-op, not a shot at a neighbour.
    const other = vi.fn();
    service.register({ active: () => true, dismiss: other });
    const remove = service.register({ active: () => false, dismiss: vi.fn() });

    remove();
    remove();

    expect(service.handle()).toBe(true);
    expect(other).toHaveBeenCalledTimes(1);
  });
});
