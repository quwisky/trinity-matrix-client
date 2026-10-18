import { vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

/** Minimal TypedEventEmitter stand-in; an array, not a Set, so a double subscription counts until `off`. */
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
