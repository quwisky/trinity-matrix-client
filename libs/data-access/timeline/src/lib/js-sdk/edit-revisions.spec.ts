import { describe, expect, it } from 'vitest';
import { EventStatus, MatrixEvent } from 'matrix-js-sdk';
import { editRevisionSources } from './edit-revisions';

/** Each version's id, timestamp and plain body, or null when it cannot be read. */
function revisionsOf(original: MatrixEvent, edits: readonly MatrixEvent[]) {
  return editRevisionSources(original, edits).map(({ event, content }) => ({
    id: event.getId(),
    timestamp: event.getTs(),
    body: content ? content['body'] : null,
  }));
}

const SENDER = '@alice:hs';

/** The original message. `content` is what it said BEFORE any edit. */
function original(
  over: {
    id?: string;
    ts?: number;
    sender?: string;
    content?: Record<string, unknown>;
    redacted?: boolean;
    undecryptable?: boolean;
  } = {},
): MatrixEvent {
  const {
    id = '$orig',
    ts = 1000,
    sender = SENDER,
    content = { msgtype: 'm.text', body: 'v1' },
    redacted = false,
    undecryptable = false,
  } = over;
  return {
    getId: () => id,
    getTs: () => ts,
    getSender: () => sender,
    getType: () => 'm.room.message',
    isRedacted: () => redacted,
    isDecryptionFailure: () => undecryptable,
    // What the timeline would render — deliberately different from the pre-edit content,
    // so a test can tell the two apart.
    getContent: () => ({ msgtype: 'm.text', body: 'latest' }),
    getOriginalContent: () => content,
    isRelation: () => false,
    isEncrypted: () => false,
    status: null,
  } as unknown as MatrixEvent;
}

/** An `m.replace` of the original. */
function edit(
  over: {
    id?: string;
    ts?: number;
    sender?: string;
    body?: string;
    formattedBody?: string;
    newContent?: Record<string, unknown> | null;
    type?: string;
    redacted?: boolean;
    undecryptable?: boolean;
    status?: EventStatus | null;
    /** The event the edit replaces. */
    target?: string;
  } = {},
): MatrixEvent {
  const {
    id = '$edit',
    target = '$orig',
    ts = 2000,
    sender = SENDER,
    body = 'v2',
    formattedBody,
    type = 'm.room.message',
    redacted = false,
    undecryptable = false,
    status = null,
  } = over;
  const newContent =
    over.newContent === undefined
      ? {
          msgtype: 'm.text',
          body,
          ...(formattedBody
            ? {
                format: 'org.matrix.custom.html',
                formatted_body: formattedBody,
              }
            : {}),
        }
      : over.newContent;
  const content = {
    msgtype: 'm.text',
    body: `* ${body}`,
    ...(newContent ? { 'm.new_content': newContent } : {}),
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  };
  return {
    getId: () => id,
    getTs: () => ts,
    getSender: () => sender,
    getType: () => type,
    isRedacted: () => redacted,
    isDecryptionFailure: () => undecryptable,
    // A failed decryption leaves the SDK's placeholder, which carries no new content.
    getContent: () => (undecryptable ? {} : content),
    getOriginalContent: () => (undecryptable ? {} : content),
    getRelation: () => ({ rel_type: 'm.replace', event_id: target }),
    isEncrypted: () => false,
    getClearContent: () => null,
    status,
  } as unknown as MatrixEvent;
}

describe('editRevisionSources', () => {
  it('leads with the original as it was before any edit', () => {
    const revisions = revisionsOf(original(), [edit()]);

    expect(revisions.map((r) => r.body)).toEqual(['v1', 'v2']);
    // The pre-edit text, NOT what getContent() now resolves to.
    expect(revisions[0].body).not.toBe('latest');
    expect(revisions[0].id).toBe('$orig');
    expect(revisions[0].timestamp).toBe(1000);
  });

  it('reads each version from m.new_content, not the fallback body', () => {
    // The wire format prefixes the fallback with "* "; showing that would be a bug.
    const revisions = revisionsOf(original(), [edit({ body: 'fixed' })]);

    expect(revisions[1].body).toBe('fixed');
    expect(revisions[1].body).not.toContain('*');
  });

  // The security-relevant rule: anyone in the room can send an m.replace pointed at
  // someone else's message. Rendering it would put words in the sender's mouth.
  it('drops an edit from anyone but the original sender', () => {
    const revisions = revisionsOf(original(), [
      edit({
        id: '$mallory',
        sender: '@mallory:evil.example',
        body: 'I confess',
      }),
    ]);

    expect(revisions).toHaveLength(1);
    expect(revisions.map((r) => r.body)).not.toContain('I confess');
  });

  it('drops edits that are not messages, are redacted, or carry no new content', () => {
    const revisions = revisionsOf(original(), [
      edit({ id: '$a', type: 'm.reaction' }),
      edit({ id: '$b', redacted: true }),
      edit({ id: '$c', newContent: null }),
    ]);

    expect(revisions).toHaveLength(1); // the original only
  });

  // An in-flight or failed edit is not history yet: the timeline shows it optimistically,
  // but the history must not claim it as a version that happened.
  it('drops an edit aimed at another message, readable or not', () => {
    const revisions = revisionsOf(original(), [
      edit({ id: '$elsewhere', target: '$other' }),
      edit({ id: '$sealed', target: '$other', undecryptable: true }),
    ]);

    expect(revisions.map((r) => r.id)).toEqual(['$orig']);
  });

  it("shows each edit's own new content, never one attached to the edit", () => {
    const first = new MatrixEvent({
      event_id: '$e1',
      room_id: '!r:hs',
      sender: SENDER,
      type: 'm.room.message',
      origin_server_ts: 2000,
      content: {
        msgtype: 'm.text',
        body: '* v2',
        'm.new_content': { msgtype: 'm.text', body: 'v2' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
      },
    });
    first.makeReplaced(
      new MatrixEvent({
        event_id: '$e2',
        room_id: '!r:hs',
        sender: '@mallory:hs',
        type: 'm.room.message',
        content: {
          'm.new_content': {
            'm.new_content': { msgtype: 'm.text', body: 'FORGED' },
          },
        },
      }),
    );

    const revisions = revisionsOf(original(), [first]);

    expect(revisions.map((r) => r.body)).toEqual(['v1', 'v2']);
  });

  it('drops a local echo that has not been accepted', () => {
    const revisions = revisionsOf(original(), [
      edit({ id: '~!room:hs:txn', status: EventStatus.SENDING }),
      edit({ id: '$failed', status: EventStatus.NOT_SENT }),
    ]);

    expect(revisions).toHaveLength(1);
  });

  it('orders edits oldest first, breaking ties on id for a stable list', () => {
    const revisions = revisionsOf(original(), [
      edit({ id: '$c', ts: 3000, body: 'third' }),
      edit({ id: '$b', ts: 2000, body: 'second-b' }),
      edit({ id: '$a', ts: 2000, body: 'second-a' }),
    ]);

    expect(revisions.map((r) => r.body)).toEqual([
      'v1',
      'second-a',
      'second-b',
      'third',
    ]);
  });

  it('ignores an edit seen twice across pages', () => {
    const twice = edit({ id: '$dup' });
    const revisions = revisionsOf(original(), [twice, twice]);

    expect(revisions).toHaveLength(2);
  });

  // Deleting a message does not delete its edits on the server. Showing them would undo
  // the deletion the sender asked for.
  it('shows no history at all for a deleted message', () => {
    const revisions = revisionsOf(original({ redacted: true }), [edit()]);

    expect(revisions).toEqual([]);
  });

  it('lists a version it cannot decrypt without its content', () => {
    const revisions = revisionsOf(original({ undecryptable: true }), [
      edit({ id: '$lost', undecryptable: true }),
    ]);

    expect(revisions.map((r) => [r.id, r.body])).toEqual([
      ['$orig', null],
      ['$lost', null],
    ]);
  });
});
