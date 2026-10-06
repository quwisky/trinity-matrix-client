import { EMPTY } from 'rxjs';
import { afterEach } from 'vitest';
import { ProjectionRuntime } from './projection-runtime.service';
import type { ProjectionDefinition } from './projection-runtime.models';
import {
  setProjectionTraceSink,
  type ProjectionTraceEvent,
} from './projection-trace';

afterEach(() => {
  setProjectionTraceSink(null);
  localStorage.removeItem('trinity.debug.projections');
  vi.restoreAllMocks();
});

function definition(
  overrides: Partial<ProjectionDefinition> = {},
): ProjectionDefinition {
  return {
    id: 'trace.projection',
    scope: { kind: 'exact-account', accountId: '@alice:example.org' },
    attach: () => undefined,
    reconcile: (context) => {
      context.publish(() => undefined);
      return EMPTY;
    },
    reset: () => undefined,
    ...overrides,
  };
}

describe('projection trace', () => {
  it('traces a projection lifetime when a sink is set', () => {
    const events: ProjectionTraceEvent[] = [];
    setProjectionTraceSink((event) => events.push(event));

    new ProjectionRuntime().activate(definition()).release();

    expect(events.map((e) => e.kind)).toEqual([
      'activate',
      'publish',
      'release',
    ]);
    expect(events[0]).toMatchObject({
      id: 'trace.projection',
      scope: 'exact-account:18:@alice:example.org',
    });
  });

  it('traces a dropped stale publish', () => {
    const events: ProjectionTraceEvent[] = [];
    setProjectionTraceSink((event) => events.push(event));
    let invalidate = (): void => undefined;
    let stalePublish = (): boolean => true;
    const runtime = new ProjectionRuntime();
    runtime.activate(
      definition({
        attach: (next) => {
          invalidate = next;
        },
        reconcile: (context) => {
          stalePublish = () => context.publish(() => undefined);
          return EMPTY;
        },
      }),
    );
    const first = events.find((e) => e.kind === 'activate')?.generation;
    invalidate();

    expect(stalePublish()).toBe(false);
    expect(events.filter((e) => e.kind === 'stale-drop')).toEqual([
      expect.objectContaining({ generation: first }),
    ]);
  });

  it('logs nothing by default', () => {
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);

    new ProjectionRuntime().activate(definition()).release();

    expect(debug).not.toHaveBeenCalled();
  });

  it('logs to console.debug when the localStorage flag is set', () => {
    localStorage.setItem('trinity.debug.projections', '1');
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);

    new ProjectionRuntime().activate(definition()).release();

    expect(debug.mock.calls[0][0]).toBe('[projection]');
  });
});
