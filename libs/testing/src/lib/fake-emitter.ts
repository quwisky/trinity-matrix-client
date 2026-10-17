import { vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

/**
 * Minimal event emitter shaped like matrix-js-sdk's TypedEventEmitter. Handlers are
 * kept in an array, so subscribing the same handler twice shows in `listenerCount`.
 */
export function fakeEmitter() {
  const handlers: Record<string, Handler[]> = {};
  return {
    on: vi.fn((event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of (handlers[event] ?? []).slice()) handler(...args);
    },
    listenerCount: vi.fn((event: string) => (handlers[event] ?? []).length),
  };
}
