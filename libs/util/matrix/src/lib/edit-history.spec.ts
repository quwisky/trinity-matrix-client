import { describe, expect, it } from 'vitest';
import { EventStatus, MatrixEvent } from 'matrix-js-sdk';
import { buildEditRevisions } from './edit-history';
import { UNDECRYPTABLE_BODY } from './message-view';

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
    newContent?: unknown;
    type?: string;
    redacted?: boolean;
    undecryptable?: boolean;
    status?: EventStatus | null;
  } = {},
): MatrixEvent {
  const {
    id = '$edit',
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
  return {
    getId: () => id,
    getTs: () => ts,
    getSender: () => sender,
    getType: () => type,
    isRedacted: () => redacted,
    isDecryptionFailure: () => undecryptable,
    getContent: () => ({
      msgtype: 'm.text',
      body: `* ${body}`,
      ...(newContent ? { 'm.new_content': newContent } : {}),
      'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
    }),
    getOriginalContent: () => ({}),
    status,
  } as unknown as MatrixEvent;
}

describe('buildEditRevisions', () => {
  it('leads with the original as it was before any edit', () => {
    const revisions = buildEditRevisions(original(), [edit()], SENDER);

    expect(revisions.map((r) => r.body)).toEqual(['v1', 'v2']);
    // The pre-edit text, NOT what getContent() now resolves to.
    expect(revisions[0].body).not.toBe('latest');
    expect(revisions[0].id).toBe('$orig');
    expect(revisions[0].timestamp).toBe(1000);
  });

  it('reads each version from m.new_content, not the fallback body', () => {
    // The wire format prefixes the fallback with "* "; showing that would be a bug.
    const revisions = buildEditRevisions(
      original(),
      [edit({ body: 'fixed' })],
      SENDER,
    );

    expect(revisions[1].body).toBe('fixed');
    expect(revisions[1].body).not.toContain('*');
  });

  it('renders a formatted version through the sanitizer', () => {
    const revisions = buildEditRevisions(
      original(),
      [
        edit({
          body: 'bold',
          formattedBody: '<strong>bold</strong><script>alert(1)</script>',
        }),
      ],
      SENDER,
    );

    expect(revisions[1].html).toContain('<strong>bold</strong>');
    expect(revisions[1].html).not.toContain('script');
  });

  it('recovers a standalone Markdown link in formatted edit history', () => {
    const destination = 'https://static.example/image_name.jpg';
    const revisions = buildEditRevisions(
      original(),
      [
        edit({
          body: `[${destination.replace('_', '\\_')}](${destination.replace('_', '\\_')})`,
          formattedBody: `[${destination}](${destination})`,
        }),
      ],
      SENDER,
    );

    const container = document.createElement('div');
    container.innerHTML = revisions[1].html ?? '';
    const anchor = container.querySelector('a');

    expect(anchor?.textContent).toBe(destination);
    expect(anchor?.getAttribute('href')).toBe(destination);
    expect(container.textContent).not.toContain('](');
  });

  it('renders the reported Wikia event as the original history entry', () => {
    const destination =
      'https://static.wikia.nocookie.net/control6745/images/e/e6/' +
      'Control_-_Safeer_Abbas_-_Powerplant_enviromental_art_1.jpg';
    const escapedDestination = destination.replaceAll('_', String.raw`\\_`);
    const rawEvent = {
      age: 1_464_072_657,
      content: {
        body: `[${escapedDestination}](${escapedDestination})`,
        format: 'org.matrix.custom.html',
        formatted_body: `[${destination}](${destination})`,
        'm.mentions': {},
        msgtype: 'm.text',
      },
      event_id: '$HQt5VrE5OnJRpHxzqyQEuLHAXlcf_oQIR5yYkscjjKA',
      origin_server_ts: 1_786_382_342_397,
      room_id: '!XX:xx.com',
      sender: '@yx:xx.com',
      type: 'm.room.message',
      unsigned: {},
    };
    const event = new MatrixEvent(rawEvent);

    const [revision] = buildEditRevisions(event, [], '@me:xx.com');
    const container = document.createElement('div');
    container.innerHTML = revision.html ?? '';
    const anchor = container.querySelector('a');

    expect(revision.kind).toBe('text');
    expect(anchor?.textContent).toBe(destination);
    expect(anchor?.getAttribute('href')).toBe(destination);
    expect(container.textContent).not.toContain('](');
  });

  it('linkifies a plain-text version, as the timeline does', () => {
    const revisions = buildEditRevisions(
      original(),
      [edit({ body: 'see https://example.com' })],
      SENDER,
    );

    expect(revisions[1].html).toContain('href="https://example.com"');
  });

  // The security-relevant rule: anyone in the room can send an m.replace pointed at
  // someone else's message. Rendering it would put words in the sender's mouth.
  it('drops an edit from anyone but the original sender', () => {
    const revisions = buildEditRevisions(
      original(),
      [
        edit({
          id: '$mallory',
          sender: '@mallory:evil.example',
          body: 'I confess',
        }),
      ],
      SENDER,
    );

    expect(revisions).toHaveLength(1);
    expect(revisions.map((r) => r.body)).not.toContain('I confess');
  });

  it('drops edits that are not messages, are redacted, or carry no new content', () => {
    const revisions = buildEditRevisions(
      original(),
      [
        edit({ id: '$a', type: 'm.reaction' }),
        edit({ id: '$b', redacted: true }),
        edit({ id: '$c', newContent: null }),
      ],
      SENDER,
    );

    expect(revisions).toHaveLength(1); // the original only
  });

  it.each([
    ['an array', []],
    ['an empty object', {}],
    ['text without a body', { msgtype: 'm.text' }],
    ['non-text content', { msgtype: 'm.image', body: 'image.jpg' }],
  ])('drops m.new_content shaped as %s', (_label, newContent) => {
    const revisions = buildEditRevisions(
      original(),
      [edit({ newContent })],
      SENDER,
    );

    expect(revisions).toHaveLength(1);
  });

  // An in-flight or failed edit is not history yet: the timeline shows it optimistically,
  // but the history must not claim it as a version that happened.
  it('drops a local echo that has not been accepted', () => {
    const revisions = buildEditRevisions(
      original(),
      [
        edit({ id: '~!room:hs:txn', status: EventStatus.SENDING }),
        edit({ id: '$failed', status: EventStatus.NOT_SENT }),
      ],
      SENDER,
    );

    expect(revisions).toHaveLength(1);
  });

  it('orders edits oldest first, breaking ties on id for a stable list', () => {
    const revisions = buildEditRevisions(
      original(),
      [
        edit({ id: '$c', ts: 3000, body: 'third' }),
        edit({ id: '$b', ts: 2000, body: 'second-b' }),
        edit({ id: '$a', ts: 2000, body: 'second-a' }),
      ],
      SENDER,
    );

    expect(revisions.map((r) => r.body)).toEqual([
      'v1',
      'second-a',
      'second-b',
      'third',
    ]);
  });

  it('ignores an edit seen twice across pages', () => {
    const twice = edit({ id: '$dup' });
    const revisions = buildEditRevisions(original(), [twice, twice], SENDER);

    expect(revisions).toHaveLength(2);
  });

  // Deleting a message does not delete its edits on the server. Showing them would undo
  // the deletion the sender asked for.
  it('shows no history at all for a deleted message', () => {
    const revisions = buildEditRevisions(
      original({ redacted: true }),
      [edit()],
      SENDER,
    );

    expect(revisions).toEqual([]);
  });

  // Only the sender may remove one of their own earlier versions, so every revision
  // records whether it is theirs. Edits always share the original's sender (a foreign one
  // is dropped), so one answer covers the list.
  it('marks the versions as yours when you sent the message', () => {
    const revisions = buildEditRevisions(original(), [edit()], SENDER);

    expect(revisions.every((r) => r.isOwn)).toBe(true);
  });

  it('marks them as not yours when someone else sent it', () => {
    const revisions = buildEditRevisions(original(), [edit()], '@bob:hs');

    expect(revisions.some((r) => r.isOwn)).toBe(false);
  });

  it('treats an unknown current user as not yours', () => {
    const revisions = buildEditRevisions(original(), [edit()], null);

    expect(revisions.some((r) => r.isOwn)).toBe(false);
  });

  it('says so plainly when a version cannot be decrypted', () => {
    const revisions = buildEditRevisions(
      original({ undecryptable: true }),
      [edit({ id: '$lost', undecryptable: true })],
      SENDER,
    );

    expect(revisions.map((r) => r.kind)).toEqual([
      'undecryptable',
      'undecryptable',
    ]);
    // Never the SDK's internal "** Unable to decrypt: <reason> **" diagnostic.
    for (const revision of revisions) {
      expect(revision.body).toBe(UNDECRYPTABLE_BODY);
      expect(revision.body).not.toContain('Unable to decrypt:');
      expect(revision.html).toBeNull();
    }
  });
});
