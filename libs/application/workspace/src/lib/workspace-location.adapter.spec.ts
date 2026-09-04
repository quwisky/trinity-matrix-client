import { TestBed } from '@angular/core/testing';
import { DefaultUrlSerializer, NavigationEnd, Router } from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLocationAdapter } from './workspace-location.adapter';

const ALICE = '@alice:example.org';

function setup(initialUrl: string) {
  let url = initialUrl;
  const events = new Subject<NavigationEnd>();
  const serializer = new DefaultUrlSerializer();
  const navigate = vi.fn(() => Promise.resolve(true));
  TestBed.configureTestingModule({
    providers: [
      WorkspaceLocationAdapter,
      {
        provide: Router,
        useValue: {
          get url() {
            return url;
          },
          events,
          navigate,
          parseUrl: (value: string) => serializer.parse(value),
        },
      },
    ],
  });
  return {
    adapter: TestBed.inject(WorkspaceLocationAdapter),
    navigate,
    moveTo(next: string) {
      url = next;
      events.next(new NavigationEnd(1, next, next));
    },
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('WorkspaceLocationAdapter', () => {
  it('parses Workspace coordinates and distinguishes other routes', () => {
    const test = setup(`/rooms?account=${encodeURIComponent(ALICE)}`);

    expect(test.adapter.current(null)).toMatchObject({
      kind: 'workspace',
      parsed: {
        destination: { accountId: ALICE, roomId: null, pane: 'list' },
        canonical: true,
      },
    });
    test.moveTo('/settings');
    expect(test.adapter.current(ALICE)).toEqual({ kind: 'outside' });
  });

  it('observes the current location immediately and after navigation', () => {
    const test = setup('/settings');
    const seen: string[] = [];
    const subscription = test.adapter
      .changes(() => ALICE)
      .subscribe((location) => seen.push(location.kind));

    test.moveTo(`/rooms?account=${encodeURIComponent(ALICE)}`);

    expect(seen).toEqual(['outside', 'workspace']);
    subscription.unsubscribe();
  });

  it('keeps projection cold and hides Router commands behind the adapter', async () => {
    const test = setup('/settings');
    const command = test.adapter.project(
      {
        accountId: ALICE,
        scope: { kind: 'recent' },
        roomId: null,
        pane: 'list',
      },
      { history: 'replace' },
    );

    expect(test.navigate).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toBe(true);
    expect(test.navigate).toHaveBeenCalledWith(['/rooms'], {
      queryParams: { account: ALICE },
      replaceUrl: true,
    });
    expect(test.adapter.projecting).toBe(false);
  });
});
