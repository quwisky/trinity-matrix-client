import { describe, expect, it } from 'vitest';
import { callPowerLevelOverride } from './room-create';

// Synapse's defaults (synapse/handlers/room.py); its override replaces the whole `events` map.
const SYNAPSE_EVENTS = {
  'm.room.name': 50,
  'm.room.power_levels': 100,
  'm.room.history_visibility': 100,
  'm.room.canonical_alias': 50,
  'm.room.avatar': 50,
  'm.room.tombstone': 100,
  'm.room.server_acl': 100,
  'm.room.encryption': 100,
};

describe('callPowerLevelOverride', () => {
  it("restates Synapse's default event levels and opens call membership", () => {
    const events = callPowerLevelOverride({ roomVersion: '10' })
      .power_level_content_override?.events;

    expect(events?.['m.room.power_levels']).toBe(100);
    expect(events).toEqual({
      ...SYNAPSE_EVENTS,
      'org.matrix.msc3401.call.member': 0,
    });
  });

  it.each(['12', 'org.matrix.hydra.11'])(
    'keeps upgrades to the creators in room version %s',
    (roomVersion) => {
      expect(
        callPowerLevelOverride({ roomVersion }).power_level_content_override
          ?.events?.['m.room.tombstone'],
      ).toBe(150);
    },
  );

  it("keeps the public preset's legacy call invite level", () => {
    expect(
      callPowerLevelOverride({ roomVersion: '10', isPublic: true })
        .power_level_content_override?.events,
    ).toEqual({
      ...SYNAPSE_EVENTS,
      'm.call.invite': 50,
      'org.matrix.msc3401.call.member': 0,
    });
  });
});
