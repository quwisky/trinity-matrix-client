import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaService, type UploadedMedia } from '@trinity/data-access/media';
import {
  EngineRequestError,
  engineFail,
  type EngineFailure,
} from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeRoomOptions } from '../contract/fake-room-administration-engine';
import { RoomActionPermissionError } from './room-action-permissions.service';
import { HistoryVisibility, JoinRule } from './room-access.models';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';
import {
  KNOCK_RESTRICTED,
  RoomSettingsService,
  type RoomSettingsSnapshot,
} from './room-settings.service';

const MXC = 'mxc://example.org/photo';

/** Alice, at power 100, in a room bob created; the permissions projection is coherent. */
async function setup(options: FakeRoomOptions = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine, options);
  await engine.asBob.setPowerLevel(roomId, engine.alice, 100);
  const uploadMedia = vi.fn(() => of({ mxc: MXC } as UploadedMedia));
  TestBed.configureTestingModule({
    providers: [
      ...session.providers,
      MockProvider(MediaService, { uploadMedia }),
    ],
  });
  const projectionState = TestBed.inject(RoomAdministrationProjectionState);
  projectionState.select(engine.alice, roomId);
  projectionState.update('permissions', 'available', 'retained');
  return {
    ...session,
    roomId,
    target: { accountId: engine.alice, roomId },
    svc: TestBed.inject(RoomSettingsService),
    setState: vi.spyOn(engine, 'setState'),
    uploadMedia,
    /** Writes room state as bob. */
    put: (type: string, content: Record<string, unknown>) =>
      engine.asBob.setState(roomId, type, content as never),
    tick: () => TestBed.inject(ApplicationRef).tick(),
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('RoomSettingsService', () => {
  it('setName is cold and renames the room (trimmed) on subscribe', async () => {
    const { svc, setState, roomId, engine } = await setup();

    const action = svc.setName(roomId, '  New Name  ');
    expect(setState).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(setState).toHaveBeenCalledWith(
      engine.alice,
      roomId,
      'm.room.name',
      '',
      { name: 'New Name' },
    );
  });

  it('setTopic writes the trimmed topic with its MSC3765 plain-text rendering', async () => {
    const { svc, setState, roomId, engine } = await setup();

    await firstValueFrom(svc.setTopic(roomId, '  hello  '));
    await firstValueFrom(svc.setTopic(roomId, ''));

    expect(setState.mock.calls.map((call) => call[4])).toEqual([
      {
        topic: 'hello',
        'm.topic': { 'm.text': [{ body: 'hello', mimetype: 'text/plain' }] },
      },
      {
        topic: '',
        'm.topic': { 'm.text': [{ body: '', mimetype: 'text/plain' }] },
      },
    ]);
    expect(setState).toHaveBeenCalledWith(
      engine.alice,
      roomId,
      'm.room.topic',
      '',
      expect.anything(),
    );
  });

  it('rechecks the live state permission before a write', async () => {
    const { svc, setState, roomId, engine } = await setup();
    await engine.asBob.setPowerLevels(roomId, {
      events: { 'm.room.name': 101 },
    });

    await expect(firstValueFrom(svc.setName(roomId, 'Nope'))).rejects.toThrow(
      RoomActionPermissionError,
    );
    expect(setState).not.toHaveBeenCalled();
  });

  it('reports a write the server refuses as server-rejected', async () => {
    const { svc, roomId, engine } = await setup();
    vi.spyOn(engine, 'setState').mockReturnValue(
      of(
        engineFail({
          kind: 'network',
          code: 'request-failed',
          diagnostic: { kind: 'network' },
        } as EngineFailure),
      ),
    );

    const error = await firstValueFrom(svc.setName(roomId, 'X')).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      operation: 'set-name',
    });
  });

  it('setAvatar uploads the file through media for the target account, then writes m.room.avatar', async () => {
    const { svc, uploadMedia, setState, target } = await setup();
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    await firstValueFrom(svc.setAvatar(target, file));

    expect(uploadMedia).toHaveBeenCalledWith(
      file,
      false,
      undefined,
      undefined,
      target.accountId,
    );
    expect(setState).toHaveBeenCalledWith(
      target.accountId,
      target.roomId,
      'm.room.avatar',
      '',
      { url: MXC },
    );
  });

  it('setAvatar reports a failed upload before anything was written', async () => {
    const { svc, uploadMedia, setState, target } = await setup();
    uploadMedia.mockReturnValue(throwError(() => new Error('too large')));

    const error = await firstValueFrom(
      svc.setAvatar(target, new File(['x'], 'a.png', { type: 'image/png' })),
    ).catch((e: unknown) => e);

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'server-rejected',
      operation: 'upload-avatar',
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it('setAvatar stops after the upload when the account got a new session meanwhile', async () => {
    const { svc, uploadMedia, setState, target, signIn, engine } =
      await setup();
    const uploaded = new Subject<UploadedMedia>();
    uploadMedia.mockReturnValue(uploaded);
    const result = firstValueFrom(
      svc.setAvatar(target, new File(['x'], 'a.png', { type: 'image/png' })),
    ).catch((e: unknown) => e);

    signIn([engine.alice], { generation: 2 });
    uploaded.next({ mxc: MXC } as UploadedMedia);

    expect(((await result) as RoomAdministrationError).outcome).toMatchObject({
      failure: 'partial-update',
      operation: 'set-avatar',
      completedStep: 'media-upload',
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it('setJoinRule is cold and writes m.room.join_rules on subscribe', async () => {
    const { svc, setState, roomId } = await setup();

    const action = svc.setJoinRule(roomId, JoinRule.Public);
    expect(setState).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(setState.mock.calls[0].slice(2)).toEqual([
      'm.room.join_rules',
      '',
      { join_rule: 'public' },
    ]);
  });

  it('setJoinRule sends the allow list with a restricted rule', async () => {
    const { svc, setState, roomId } = await setup();

    await firstValueFrom(
      svc.setJoinRule(roomId, JoinRule.Restricted, ['!space:hs', '!other:hs']),
    );

    expect(setState.mock.calls[0][4]).toEqual({
      join_rule: 'restricted',
      allow: [
        { type: 'm.room_membership', room_id: '!space:hs' },
        { type: 'm.room_membership', room_id: '!other:hs' },
      ],
    });
  });

  it('setJoinRule preserves unfamiliar restricted allow entries', async () => {
    const unknown = {
      type: 'org.example.membership_claim',
      issuer: 'example.org',
    };
    const { svc, setState, roomId, put } = await setup();
    await put('m.room.join_rules', {
      join_rule: 'restricted',
      allow: [{ type: 'm.room_membership', room_id: '!old:hs' }, unknown],
    });

    await firstValueFrom(
      svc.setJoinRule(roomId, JoinRule.Restricted, ['!new:hs']),
    );

    expect(setState.mock.calls[0][4]).toEqual({
      join_rule: 'restricted',
      allow: [{ type: 'm.room_membership', room_id: '!new:hs' }, unknown],
    });
  });

  it('setJoinRule rejects an invalid allowed Space ID before writing', async () => {
    const { svc, setState, roomId } = await setup();

    await expect(
      firstValueFrom(
        svc.setJoinRule(roomId, JoinRule.Restricted, ['not-a-room-id']),
      ),
    ).rejects.toThrow('valid Matrix Room ID');
    expect(setState).not.toHaveBeenCalled();
  });

  it('setJoinRule de-duplicates allowed Spaces before writing', async () => {
    const { svc, setState, roomId } = await setup();

    await firstValueFrom(
      svc.setJoinRule(roomId, JoinRule.Restricted, ['!space:hs', '!space:hs']),
    );

    expect(setState.mock.calls[0][4]).toEqual({
      join_rule: 'restricted',
      allow: [{ type: 'm.room_membership', room_id: '!space:hs' }],
    });
  });

  it('setJoinRule refuses a restricted rule with nothing allowed', async () => {
    // Sending this would lock every member out of a room only an admin could reopen, so it
    // is refused in the service — the one place every join-rule write passes through.
    const { svc, setState, roomId } = await setup();

    await expect(
      firstValueFrom(svc.setJoinRule(roomId, JoinRule.Restricted)),
    ).rejects.toThrow(/at least one space/i);
    expect(setState).not.toHaveBeenCalled();
  });

  it('setJoinRule omits allow entirely for a non-restricted rule', async () => {
    // An `allow` left on a public rule is ignored by the server but misleads every client
    // that reads the state back, including our own seeding.
    const { svc, setState, roomId } = await setup();

    await firstValueFrom(
      svc.setJoinRule(roomId, JoinRule.Public, ['!space:hs']),
    );

    expect(setState.mock.calls[0][4]).toEqual({ join_rule: 'public' });
  });

  it.each([
    ['6', false, false],
    ['7', true, false],
    ['9', true, false],
    ['10', true, true],
    ['x', false, false],
  ])(
    'version %s supports knock %s, knock_restricted %s',
    async (roomVersion, knock, knockRestricted) => {
      const { svc, roomId } = await setup({ roomVersion });
      expect(svc.supportsKnock(roomId)).toBe(knock);
      expect(svc.supportsKnockRestricted(roomId)).toBe(knockRestricted);
    },
  );

  it('snapshot carries both knock support flags', async () => {
    const { svc, target } = await setup({ roomVersion: '10' });
    const snapshot = await firstValueFrom(svc.observe(target));
    expect(snapshot.supportsKnock).toBe(true);
    expect(snapshot.supportsKnockRestricted).toBe(true);
  });

  it('knock_restricted save writes allow like restricted', async () => {
    const { svc, setState, roomId } = await setup();

    await firstValueFrom(
      svc.setJoinRule(roomId, KNOCK_RESTRICTED, ['!space:hs']),
    );

    expect(setState.mock.calls[0][4]).toEqual({
      join_rule: 'knock_restricted',
      allow: [{ type: 'm.room_membership', room_id: '!space:hs' }],
    });
  });

  it('knock_restricted with no spaces is refused', async () => {
    const { svc, setState, roomId } = await setup();

    await expect(
      firstValueFrom(svc.setJoinRule(roomId, KNOCK_RESTRICTED)),
    ).rejects.toThrow(/at least one space/i);
    expect(setState).not.toHaveBeenCalled();
  });

  it('knock save writes no allow', async () => {
    const { svc, setState, roomId } = await setup();

    await firstValueFrom(
      svc.setJoinRule(roomId, JoinRule.Knock, ['!space:hs']),
    );

    expect(setState.mock.calls[0][4]).toEqual({ join_rule: 'knock' });
  });

  it('currentAccess reads the allowed spaces of a knock_restricted rule', async () => {
    const { svc, roomId, put } = await setup();
    await put('m.room.join_rules', {
      join_rule: 'knock_restricted',
      allow: [{ type: 'm.room_membership', room_id: '!space:hs' }],
    });

    expect(svc.currentAccess(roomId).allowedSpaceIds).toEqual(['!space:hs']);
  });

  it('currentAccess reads the allowed spaces of a restricted rule', async () => {
    const { svc, roomId, put } = await setup();
    await put('m.room.join_rules', {
      join_rule: 'restricted',
      allow: [
        { type: 'm.room_membership', room_id: '!space:hs' },
        { type: 'm.room_membership', room_id: '!two:hs' },
      ],
    });

    expect(svc.currentAccess(roomId).allowedSpaceIds).toEqual([
      '!space:hs',
      '!two:hs',
    ]);
  });

  it('setJoinRule rejects rather than writing when signed out', async () => {
    // Every write in this service defers its signed-in check to subscribe time, so a
    // caller that built the Observable before a logout must not reach the engine.
    const { svc, setState, roomId, target, signIn } = await setup();
    const byRoom = svc.setJoinRule(roomId, JoinRule.Public);
    const byTarget = svc.setJoinRule(target, JoinRule.Public);
    signIn([]);

    await expect(firstValueFrom(byRoom)).rejects.toThrow(/not signed in/i);
    await expect(firstValueFrom(byTarget)).rejects.toThrow(/not signed in/i);
    expect(setState).not.toHaveBeenCalled();
  });

  it('reads blanks, spec defaults and no permissions when signed out', async () => {
    // The opener calls these synchronously just before creating the dialog; throwing here
    // would take the whole settings dialog down rather than open it empty.
    const { svc, roomId, put, signIn } = await setup({ roomVersion: '10' });
    await put('m.room.name', { name: 'Design' });
    await put('m.room.join_rules', { join_rule: 'public' });
    signIn([]);

    expect(svc.currentIdentity(roomId)).toEqual({
      name: '',
      topic: '',
      avatarMxc: null,
    });
    expect(svc.currentAccess(roomId)).toEqual({
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
      allowedSpaceIds: [],
    });
    // False rather than throwing: a wrong `true` would offer a choice that cannot be written.
    expect(svc.supportsRestricted(roomId)).toBe(false);
    expect(svc.editableFields(roomId)).toEqual({
      name: false,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    });
  });

  it('currentAccess ignores an allow list left under a non-restricted rule', async () => {
    // Inert state some other client left behind. Surfacing it would make the dialog see an
    // access change where there is none, and then write one on an unrelated save.
    const { svc, roomId, put } = await setup();
    await put('m.room.join_rules', {
      join_rule: 'public',
      allow: [{ type: 'm.room_membership', room_id: '!stale:hs' }],
    });

    expect(svc.currentAccess(roomId).allowedSpaceIds).toEqual([]);
  });

  it('currentAccess collapses a repeated allow entry', async () => {
    // A caller comparing this against a list it built cannot tell ['!a','!a'] from ['!a']
    // by size, so the duplicate has to go before it is ever handed out.
    const { svc, roomId, put } = await setup();
    await put('m.room.join_rules', {
      join_rule: 'restricted',
      allow: [
        { type: 'm.room_membership', room_id: '!a:hs' },
        { type: 'm.room_membership', room_id: '!a:hs' },
      ],
    });

    expect(svc.currentAccess(roomId).allowedSpaceIds).toEqual(['!a:hs']);
  });

  it('currentAccess drops malformed allow entries rather than surfacing them', async () => {
    // The list is arbitrary state any client may have written. An empty-string id read back
    // here would be written straight back out on the next save.
    const { svc, roomId, put } = await setup();
    await put('m.room.join_rules', {
      join_rule: 'restricted',
      allow: [
        { type: 'm.room_membership', room_id: '!good:hs' },
        { type: 'm.room_membership' },
        { type: 'm.room_membership', room_id: '' },
        { type: 'something.else', room_id: '!bad:hs' },
        null,
        'nonsense',
      ],
    });

    expect(svc.currentAccess(roomId).allowedSpaceIds).toEqual(['!good:hs']);
  });

  it.each([
    // Version 7 accepts the string and enforces nothing, so the room silently stays as
    // open as it was — worse than refusing the option.
    ['8', true],
    ['7', false],
    ['org.example.9', false],
  ])(
    'supportsRestricted for room version %s is %s (MSC3083 landed in 8)',
    async (roomVersion, supported) => {
      const { svc, roomId } = await setup({ roomVersion });
      expect(svc.supportsRestricted(roomId)).toBe(supported);
    },
  );

  it('reads blanks, defaults and nothing editable for a room the account does not know', async () => {
    const { svc } = await setup();

    expect(svc.supportsRestricted('!nope:hs')).toBe(false);
    expect(svc.currentIdentity('!nope:hs')).toEqual({
      name: '',
      topic: '',
      avatarMxc: null,
    });
    expect(svc.editableFields('!nope:hs')).toEqual({
      name: false,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    });
  });

  it('setHistoryVisibility is cold and writes m.room.history_visibility', async () => {
    const { svc, setState, roomId } = await setup();

    const action = svc.setHistoryVisibility(
      roomId,
      HistoryVisibility.WorldReadable,
    );
    expect(setState).not.toHaveBeenCalled();

    await firstValueFrom(action);
    expect(setState.mock.calls[0].slice(2)).toEqual([
      'm.room.history_visibility',
      '',
      { history_visibility: 'world_readable' },
    ]);
  });

  it('currentAccess reads the room state', async () => {
    const { svc, roomId, put } = await setup();
    await put('m.room.join_rules', { join_rule: 'public' });
    await put('m.room.history_visibility', {
      history_visibility: 'world_readable',
    });

    expect(svc.currentAccess(roomId)).toEqual({
      joinRule: JoinRule.Public,
      historyVisibility: HistoryVisibility.WorldReadable,
      allowedSpaceIds: [],
    });
  });

  it('currentAccess falls back to the spec defaults when state is absent', async () => {
    const { svc, roomId } = await setup();

    expect(svc.currentAccess(roomId)).toEqual({
      joinRule: JoinRule.Invite,
      historyVisibility: HistoryVisibility.Shared,
      allowedSpaceIds: [],
    });
  });

  it('currentIdentity reads name, topic and avatar from state', async () => {
    const { svc, roomId, put } = await setup();
    await put('m.room.name', { name: 'General' });
    await put('m.room.topic', { topic: 'The topic' });
    await put('m.room.avatar', { url: 'mxc://hs/abc' });

    expect(svc.currentIdentity(roomId)).toEqual({
      name: 'General',
      topic: 'The topic',
      avatarMxc: 'mxc://hs/abc',
    });
  });

  it('currentIdentity returns blanks rather than inventing a name', async () => {
    // A computed room name invents one from the member list for a nameless room. Seeding a
    // form with that would compare the input against something nobody typed, and then write
    // the invention back as a real name.
    const { svc, roomId } = await setup();

    expect(svc.currentIdentity(roomId)).toEqual({
      name: '',
      topic: '',
      avatarMxc: null,
    });
  });

  it('editableFields reflects per-field power (name yes, the rest no)', async () => {
    const { svc, roomId, engine } = await setup();
    await engine.asBob.setPowerLevels(roomId, {
      state_default: 101,
      events: { 'm.room.name': 50 },
    });

    expect(svc.editableFields(roomId)).toEqual({
      name: true,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    });
  });

  it('keeps exact Account ownership after the active Account changes', async () => {
    const { svc, setState, target, engine, signIn } = await setup();
    engine.setLive(engine.bob, true);
    signIn([engine.alice, engine.bob], { active: engine.bob });

    await firstValueFrom(svc.setName(target, 'Exact target'));

    expect(setState).toHaveBeenCalledWith(
      engine.alice,
      target.roomId,
      'm.room.name',
      '',
      { name: 'Exact target' },
    );
  });

  it('observes exact Room state and never retargets when Account activity changes', async () => {
    const { svc, target, put, tick, engine, signIn } = await setup();
    await put('m.room.name', { name: 'Before' });
    const snapshots: RoomSettingsSnapshot[] = [];
    const subscription = svc
      .observe(target)
      .subscribe((snapshot) => snapshots.push(snapshot));

    expect(snapshots.map(({ identity }) => identity.name)).toEqual(['Before']);
    engine.setLive(engine.bob, true);
    signIn([engine.alice, engine.bob], { active: engine.bob });
    await put('m.room.name', { name: 'After' });
    tick();

    expect(snapshots.at(-1)).toMatchObject({
      target,
      openingAccountActive: false,
      identity: { name: 'After' },
    });
    subscription.unsubscribe();
  });

  it('stops recomputing an observed snapshot once unsubscribed', async () => {
    const { svc, target, put, tick } = await setup();
    const snapshot = vi.spyOn(svc, 'snapshot');
    const subscription = svc.observe(target).subscribe();
    tick();
    subscription.unsubscribe();
    const calls = snapshot.mock.calls.length;

    await put('m.room.name', { name: 'Later' });
    tick();

    expect(snapshot.mock.calls.length).toBe(calls);
  });

  it('shows encryption on for a room the crypto store has as encrypted when its state lacks the event', async () => {
    const { svc, target, roomId, engine, tick } = await setup({
      encryptionUnknown: true,
    });
    const snapshots: RoomSettingsSnapshot[] = [];
    const subscription = svc
      .observe(target)
      .subscribe((snapshot) => snapshots.push(snapshot));

    engine.answerEncryption(roomId, true);
    tick();

    expect(snapshots.at(-1)).toMatchObject({
      encrypted: true,
      advanced: { encrypted: true },
    });
    subscription.unsubscribe();
  });

  it('keeps encryption off when the room state and the crypto store both say so', async () => {
    const { svc, target } = await setup();

    expect(svc.snapshot(target)).toMatchObject({
      encrypted: false,
      advanced: { encrypted: false },
    });
  });

  it('reports encryption as unknown, so nothing offers to turn it on, until the crypto store answers', async () => {
    const { svc, target, roomId, engine, tick } = await setup({
      encryptionUnknown: true,
    });
    const snapshots: (boolean | null)[] = [];
    const subscription = svc
      .observe(target)
      .subscribe((snapshot) => snapshots.push(snapshot.encrypted));

    expect(snapshots).toEqual([null]);
    expect(svc.snapshot(target)).toMatchObject({
      encrypted: null,
      advanced: { encrypted: false },
    });
    engine.answerEncryption(roomId, false);
    tick();
    expect(snapshots.at(-1)).toBe(false);
    subscription.unsubscribe();
  });

  it('classifies a signed-out exact target without inventing readable state', async () => {
    const { svc, target, put, signIn } = await setup();
    await put('m.room.name', { name: 'Private' });
    await put('m.room.topic', { topic: 'Secret' });
    signIn([]);

    expect(svc.snapshot(target)).toMatchObject({
      availability: 'account-unavailable',
      unavailableReason: expect.stringContaining('account'),
      identity: { name: '', topic: '', avatarMxc: null },
      encrypted: null,
    });
  });

  it('recomputes the advanced details when Room state changes', async () => {
    const { svc, target, put, tick } = await setup();
    const successors: (string | null)[] = [];
    const subscription = svc
      .observe(target)
      .subscribe((snapshot) => successors.push(snapshot.advanced.successor));

    expect(svc.snapshot(target).advanced).toMatchObject({
      roomId: target.roomId,
      version: '10',
      successor: null,
    });
    await put('m.room.tombstone', { replacement_room: '!next:hs' });
    tick();

    expect(successors.at(-1)).toBe('!next:hs');
    subscription.unsubscribe();
  });

  it('lists every current state event of the target, cold', async () => {
    const { svc, target, engine } = await setup();
    const stateEvents = vi.spyOn(engine, 'stateEvents');

    const entries = svc.stateEvents(target);
    expect(stateEvents).not.toHaveBeenCalled();

    expect(await firstValueFrom(entries)).toContainEqual({
      type: 'm.room.create',
      stateKey: '',
      event: expect.objectContaining({
        type: 'm.room.create',
        content: { room_version: '10' },
      }),
    });
    expect(stateEvents).toHaveBeenCalledWith(target.accountId, target.roomId);
  });

  it('lists no state for a Room the Account cannot see', async () => {
    const { svc, engine, signIn, target } = await setup();

    expect(
      await firstValueFrom(
        svc.stateEvents({ accountId: engine.alice, roomId: '!nope:hs' }),
      ),
    ).toEqual([]);
    engine.setLive(engine.alice, false);
    signIn([]);
    expect(await firstValueFrom(svc.stateEvents(target))).toEqual([]);
  });

  it('fails a state listing the server refuses', async () => {
    const { svc, engine, target } = await setup();
    vi.spyOn(engine, 'stateEvents').mockReturnValue(
      of(
        engineFail({
          kind: 'network',
          code: 'request-failed',
          diagnostic: { kind: 'network' },
        } as EngineFailure),
      ),
    );

    await expect(firstValueFrom(svc.stateEvents(target))).rejects.toThrow(
      EngineRequestError,
    );
  });
});
