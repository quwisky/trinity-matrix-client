import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSurface } from './workspace-surface.models';
import { WorkspaceBackService } from './workspace-back.service';

const application = {
  layer: 'application',
  surface: { kind: 'settings', section: 'security' },
} as const satisfies WorkspaceSurface;
const room = {
  layer: 'room',
  surface: { kind: 'thread', rootEventId: '$root' },
} as const satisfies WorkspaceSurface;
const conversation = {
  layer: 'conversation',
  surface: {
    kind: 'conversation',
    accountId: '@alice:example.org',
    roomId: '!room:example.org',
  },
} as const satisfies WorkspaceSurface;

describe('WorkspaceBackService', () => {
  let service: WorkspaceBackService;

  beforeEach(() => {
    service = TestBed.configureTestingModule({}).inject(WorkspaceBackService);
  });

  it('applies application, Room, then compact Conversation order', async () => {
    const activeApplication = signal<WorkspaceSurface | null>(application);
    const order: string[] = [];
    service.register({
      surface: () => conversation,
      dismiss: () => {
        order.push('conversation');
        return of('dismissed');
      },
    });
    service.register({
      surface: () => room,
      dismiss: () => {
        order.push('room');
        return of('dismissed');
      },
    });
    service.register({
      surface: activeApplication,
      dismiss: () => {
        order.push('application');
        return of('dismissed');
      },
    });

    await expect(firstValueFrom(service.back())).resolves.toEqual({
      kind: 'dismissed',
      surface: application,
    });
    activeApplication.set(null);
    await firstValueFrom(service.back());

    expect(order).toEqual(['application', 'room']);
    expect(service.activeSurface()).toEqual(room);
  });

  it('uses the newest adapter only within the same semantic layer', async () => {
    const first = vi.fn(() => of<'dismissed'>('dismissed'));
    const second = vi.fn(() => of<'dismissed'>('dismissed'));
    service.register({ surface: () => room, dismiss: first });
    service.register({
      surface: () => ({
        layer: 'room',
        surface: { kind: 'members' },
      }),
      dismiss: second,
    });

    await firstValueFrom(service.back());

    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it('reports whether the active semantic adapter owns the top UI overlay', () => {
    let ownsTop = false;
    service.register({
      surface: () => room,
      dismiss: () => of('dismissed'),
      ownsTopmostOverlay: () => ownsTop,
    });

    expect(service.activeOwnsTopmostOverlay()).toBe(false);
    ownsTop = true;
    expect(service.activeOwnsTopmostOverlay()).toBe(true);
  });

  it('is cold and captures the active surface on subscription', async () => {
    const active = signal<WorkspaceSurface | null>(room);
    const dismiss = vi.fn(() => of<'dismissed'>('dismissed'));
    service.register({ surface: active, dismiss });
    const command = service.back();

    active.set(conversation);
    expect(dismiss).not.toHaveBeenCalled();
    await firstValueFrom(command);

    expect(dismiss).toHaveBeenCalledWith(conversation);
  });

  it('reports blocked and empty dismissals without falling through', async () => {
    service.register({
      surface: () => application,
      dismiss: () => of('blocked'),
    });

    await expect(firstValueFrom(service.back())).resolves.toEqual({
      kind: 'blocked',
      surface: application,
    });
  });

  it('reports unhandled after an idempotently removed adapter', async () => {
    const remove = service.register({
      surface: () => room,
      dismiss: () => of('dismissed'),
    });
    remove();
    remove();

    await expect(firstValueFrom(service.back())).resolves.toEqual({
      kind: 'unhandled',
    });
    expect(service.hasActive()).toBe(false);
  });
});
