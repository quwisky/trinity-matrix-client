import { describe, expect, it } from 'vitest';

const account = {
  username: 'edit_history_owner',
  userId: '@edit_history_owner:localhost',
  password: 'private-test-password',
  homeserver: 'http://localhost:8008',
};
const bearer = 'private-test-bearer';

function serverModel() {
  const requests = [];
  const cleanups = [];
  const events = new Map();
  const originalContent = new Map();
  const roomRequests = [];
  let nextEvent = 1;
  let nextRoom = 1;
  let mode = 'valid';
  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  });
  const resources = {
    cleanup(label, work) {
      cleanups.push({ label, work });
    },
  };
  const base = {
    async createRoom(owner, content) {
      roomRequests.push({ owner, content });
      return { id: `!room${nextRoom++}:localhost`, name: content.name };
    },
  };
  const redact = (id) => {
    const event = events.get(id);
    if (!event) throw new Error('Test event missing');
    events.set(id, {
      ...event,
      content: {},
      unsigned: { redacted_because: { type: 'm.room.redaction' } },
    });
  };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname;
    init.signal.throwIfAborted();
    requests.push({
      path,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    if (path.endsWith('/login'))
      return response({ user_id: account.userId, access_token: bearer });
    if (path.endsWith('/logout')) return response({});
    const send = path.match(
      /\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/u,
    );
    if (send) {
      const content = JSON.parse(init.body);
      const eventId = `$event${nextEvent++}:localhost`;
      const event = {
        event_id: eventId,
        room_id: decodeURIComponent(send[1]),
        sender: account.userId,
        type: 'm.room.message',
        content,
        unsigned: {},
      };
      events.set(eventId, event);
      originalContent.set(eventId, content);
      return response({ event_id: eventId });
    }
    const redactPath = path.match(
      /\/rooms\/([^/]+)\/redact\/([^/]+)\/([^/]+)$/u,
    );
    if (redactPath) {
      redact(decodeURIComponent(redactPath[2]));
      return response({ event_id: '$redaction:localhost' });
    }
    const direct = path.match(/\/rooms\/([^/]+)\/event\/([^/]+)$/u);
    if (direct) {
      const id = decodeURIComponent(direct[2]);
      const event = events.get(id);
      if (!event) return response({ errcode: 'M_NOT_FOUND' }, 404);
      if (mode === 'unredacted-direct' && event.unsigned.redacted_because)
        return response({
          ...event,
          content: originalContent.get(id),
          unsigned: {},
        });
      return response(event);
    }
    const relation = path.match(
      /\/rooms\/([^/]+)\/relations\/([^/]+)\/m\.replace\/m\.room\.message$/u,
    );
    if (relation) {
      const roomId = decodeURIComponent(relation[1]);
      const target = decodeURIComponent(relation[2]);
      if (
        mode === 'suppress-relations-for-redacted-parent' &&
        events.get(target)?.unsigned.redacted_because
      )
        return response({ chunk: [] });
      let matches = [...events.values()]
        .filter(
          (event) =>
            event.room_id === roomId &&
            event.content?.['m.relates_to']?.event_id === target,
        )
        .reverse();
      if (mode === 'stale-removed') {
        const redacted = [...events.values()].find(
          (event) =>
            event.room_id === roomId &&
            event.unsigned.redacted_because &&
            originalContent.get(event.event_id)?.['m.relates_to']?.event_id ===
              target,
        );
        if (redacted)
          matches = [
            {
              ...redacted,
              content: originalContent.get(redacted.event_id),
              unsigned: {},
            },
            ...matches,
          ];
      }
      if (mode === 'duplicate-live' && matches.length)
        matches = [matches[0], ...matches];
      if (mode === 'wrong-sender' && matches.length)
        matches = [
          { ...matches[0], sender: '@intruder:localhost' },
          ...matches.slice(1),
        ];
      if (mode === 'wrong-target' && matches.length)
        matches = [
          {
            ...matches[0],
            content: {
              ...matches[0].content,
              'm.relates_to': {
                rel_type: 'm.replace',
                event_id: '$wrong:localhost',
              },
            },
          },
          ...matches.slice(1),
        ];
      if (mode === 'unexpected-live' && matches.length)
        matches = [
          { ...matches[0], event_id: '$unknown:localhost' },
          ...matches,
        ];
      if (mode === 'missing-page') matches = matches.slice(0, 1);
      const offset = Number(url.searchParams.get('from') ?? '0');
      const chunk = matches.slice(offset, offset + 1);
      return response({
        chunk,
        ...(offset + 1 < matches.length
          ? { next_batch: String(offset + 1) }
          : {}),
      });
    }
    return response({ errcode: 'M_UNRECOGNIZED' }, 404);
  };
  return {
    resources,
    base,
    fetchImpl,
    requests,
    cleanups,
    events,
    roomRequests,
    redact,
    setMode(value) {
      mode = value;
    },
  };
}

describe('Android edit-history REST fixture', () => {
  it('seeds same-target plain and formatted edits plus a redacted message', async () => {
    const model = serverModel();
    const { createEditHistoryFixtures } =
      await import('../e2e/android/edit-history-fixture.mts');
    const fixtures = createEditHistoryFixtures(
      model.resources,
      new AbortController().signal,
      model.base,
      model.fetchImpl,
    );
    const seed = await fixtures.lifecycle(account, 'History room', 'run-plain');
    expect(model.cleanups.map(({ label }) => label)).toEqual([
      'Edit-history REST sessions',
    ]);
    expect(model.roomRequests).toEqual([
      {
        owner: account,
        content: { name: 'History room', preset: 'private_chat' },
      },
    ]);
    expect(seed.roomName).toBe('History room');
    expect(seed.plain.versions).toEqual([
      'first draft run-plain',
      'second draft run-plain',
      'final wording run-plain',
    ]);
    const [firstEdit, finalEdit] = seed.plain.editIds;
    expect(model.events.get(firstEdit).content).toEqual({
      msgtype: 'm.text',
      body: '* second draft run-plain',
      'm.new_content': { msgtype: 'm.text', body: 'second draft run-plain' },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: seed.plain.originalId,
      },
    });
    expect(model.events.get(finalEdit).content['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: seed.plain.originalId,
    });
    expect(model.events.get(seed.formatted.editId).content).toEqual({
      msgtype: 'm.text',
      body: '* deploy on Monday run-plain',
      'm.new_content': {
        msgtype: 'm.text',
        body: 'deploy on Monday run-plain',
        format: 'org.matrix.custom.html',
        formatted_body: 'deploy on <strong>Monday</strong> run-plain',
      },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: seed.formatted.originalId,
      },
    });
    expect(model.events.get(seed.doomed.originalId).content).toEqual({});
    expect(
      model.events.get(seed.doomed.originalId).unsigned.redacted_because,
    ).toBeTruthy();
    expect(seed.doomed.body).toBe('deleted message run-plain');
    expect(model.events.get(seed.doomed.editId).content).toEqual({
      msgtype: 'm.text',
      body: '* deleted message run-plain (edited)',
      'm.new_content': {
        msgtype: 'm.text',
        body: 'deleted message run-plain (edited)',
      },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: seed.doomed.originalId,
      },
    });
    expect(JSON.stringify(seed)).not.toContain(bearer);
    expect(
      model.requests
        .filter(({ path }) => !path.endsWith('/login'))
        .every(({ headers }) => headers.Authorization?.startsWith('Bearer ')),
    ).toBe(true);
  });

  it('seeds long Pixel 5 versions with two replacements against one original', async () => {
    const model = serverModel();
    const { createEditHistoryFixtures } =
      await import('../e2e/android/edit-history-fixture.mts');
    const fixtures = createEditHistoryFixtures(
      model.resources,
      new AbortController().signal,
      model.base,
      model.fetchImpl,
    );
    const seed = await fixtures.pixel5(account, 'Pixel room', 'run-pixel');
    expect(seed.editIds).toHaveLength(2);
    expect(new Set(seed.editIds).size).toBe(2);
    expect(seed.editIds.every((id) => model.events.has(id))).toBe(true);
    expect(seed.versions).toHaveLength(3);
    expect(
      seed.versions.every(
        (version) => version.length > 600 && version.includes('run-pixel'),
      ),
    ).toBe(true);
    const replacements = [...model.events.values()].filter(
      (event) => event.content['m.relates_to'],
    );
    expect(replacements).toHaveLength(2);
    expect(
      replacements.map((event) => event.content['m.relates_to'].event_id),
    ).toEqual([seed.originalId, seed.originalId]);
    expect(replacements.map((event) => event.content.body)).toEqual(
      seed.versions.slice(1).map((version) => `* ${version}`),
    );
  });

  it('paginates authoritative relations and proves removal of the exact edit', async () => {
    const model = serverModel();
    const { createEditHistoryFixtures } =
      await import('../e2e/android/edit-history-fixture.mts');
    const fixtures = createEditHistoryFixtures(
      model.resources,
      new AbortController().signal,
      model.base,
      model.fetchImpl,
    );
    const seed = await fixtures.lifecycle(
      account,
      'Relations room',
      'run-relations',
    );
    const edits = seed.plain.editIds;
    expect(
      await fixtures.serverState(
        account,
        seed.roomId,
        seed.plain.originalId,
        edits,
        edits,
      ),
    ).toEqual({ removedRedacted: true, liveCount: 2, survivorMatches: true });
    expect(
      model.requests.filter(({ path }) => path.includes('/relations/')).length,
    ).toBe(2);
    model.redact(edits[1]);
    expect(
      await fixtures.serverState(
        account,
        seed.roomId,
        seed.plain.originalId,
        edits,
        [edits[0]],
      ),
    ).toEqual({ removedRedacted: true, liveCount: 1, survivorMatches: true });
  });

  it('proves formatted wire content and the redacted original with its live edit', async () => {
    const model = serverModel();
    const { createEditHistoryFixtures } =
      await import('../e2e/android/edit-history-fixture.mts');
    const fixtures = createEditHistoryFixtures(
      model.resources,
      new AbortController().signal,
      model.base,
      model.fetchImpl,
    );
    const seed = await fixtures.lifecycle(account, 'Other chains', 'run-other');
    await expect(
      fixtures.serverState(
        account,
        seed.roomId,
        seed.formatted.originalId,
        [seed.formatted.editId],
        [seed.formatted.editId],
      ),
    ).resolves.toEqual({
      removedRedacted: true,
      liveCount: 1,
      survivorMatches: true,
    });
    model.setMode('suppress-relations-for-redacted-parent');
    await expect(
      fixtures.liveEditEvent(
        account,
        seed.roomId,
        seed.doomed.originalId,
        seed.doomed.editId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      fixtures.redactedOriginal(account, seed.roomId, seed.doomed.originalId),
    ).resolves.toBeUndefined();
    model.setMode('unredacted-direct');
    await expect(
      fixtures.redactedOriginal(account, seed.roomId, seed.doomed.originalId),
    ).rejects.toThrow('Redacted original');
    model.setMode('valid');
    const edit = model.events.get(seed.doomed.editId);
    model.events.set(seed.doomed.editId, {
      ...edit,
      content: { ...edit.content, body: '* tampered' },
    });
    await expect(
      fixtures.liveEditEvent(
        account,
        seed.roomId,
        seed.doomed.originalId,
        seed.doomed.editId,
      ),
    ).rejects.toThrow('Live edit retains its exact wire content');
  });

  it.each([
    ['wrong-sender', 'sender'],
    ['wrong-target', 'm.relates_to'],
    ['duplicate-live', 'Exact live edit order'],
    ['unexpected-live', 'content'],
    ['missing-page', 'Exact live edit order'],
  ])(
    'rejects %s relations instead of claiming server repair',
    async (mode, message) => {
      const model = serverModel();
      const { createEditHistoryFixtures } =
        await import('../e2e/android/edit-history-fixture.mts');
      const fixtures = createEditHistoryFixtures(
        model.resources,
        new AbortController().signal,
        model.base,
        model.fetchImpl,
      );
      const seed = await fixtures.lifecycle(
        account,
        'Invalid relation room',
        `run-${mode}`,
      );
      model.setMode(mode);
      await expect(
        fixtures.serverState(
          account,
          seed.roomId,
          seed.plain.originalId,
          seed.plain.editIds,
          seed.plain.editIds,
        ),
      ).rejects.toThrow(message);
    },
  );

  it.each(['stale-removed', 'unredacted-direct'])(
    'rejects %s after an edit is removed',
    async (mode) => {
      const model = serverModel();
      const { createEditHistoryFixtures } =
        await import('../e2e/android/edit-history-fixture.mts');
      const fixtures = createEditHistoryFixtures(
        model.resources,
        new AbortController().signal,
        model.base,
        model.fetchImpl,
      );
      const seed = await fixtures.lifecycle(
        account,
        'Redaction room',
        `run-${mode}`,
      );
      model.redact(seed.plain.editIds[1]);
      model.setMode(mode);
      await expect(
        fixtures.serverState(
          account,
          seed.roomId,
          seed.plain.originalId,
          seed.plain.editIds,
          [seed.plain.editIds[0]],
        ),
      ).rejects.toThrow();
    },
  );

  it('logs out through an independent bounded signal after cancellation', async () => {
    const model = serverModel();
    const controller = new AbortController();
    const { createEditHistoryFixtures } =
      await import('../e2e/android/edit-history-fixture.mts');
    const fixtures = createEditHistoryFixtures(
      model.resources,
      controller.signal,
      model.base,
      model.fetchImpl,
    );
    await fixtures.pixel5(account, 'Logout room', 'run-logout');
    controller.abort(new Error('test cancellation'));
    await model.cleanups[0].work();
    const logout = model.requests.find(({ path }) => path.endsWith('/logout'));
    expect(logout).toBeDefined();
    expect(logout.signal.aborted).toBe(false);
    expect(logout.signal).not.toBe(controller.signal);
    expect(logout.headers.Authorization?.startsWith('Bearer ')).toBe(true);
  });
});
