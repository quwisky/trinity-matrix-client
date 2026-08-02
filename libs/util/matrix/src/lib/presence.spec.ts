import { describe, expect, it } from 'vitest';
import { presenceLabel, toPresenceState } from './presence';

describe('toPresenceState', () => {
  it('passes through the known online/unavailable states', () => {
    expect(toPresenceState('online')).toBe('online');
    expect(toPresenceState('unavailable')).toBe('unavailable');
  });

  it('maps offline, unknown, and absent values to offline', () => {
    expect(toPresenceState('offline')).toBe('offline');
    expect(toPresenceState('weird')).toBe('offline');
    expect(toPresenceState(null)).toBe('offline');
    expect(toPresenceState(undefined)).toBe('offline');
  });
});

describe('presenceLabel', () => {
  it('labels each state (unavailable reads as Away)', () => {
    expect(presenceLabel('online')).toBe('Online');
    expect(presenceLabel('unavailable')).toBe('Away');
    expect(presenceLabel('offline')).toBe('Offline');
  });
});
