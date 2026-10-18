import type { MessageView } from '@trinity/data-access/timeline';
import type { MessageRow } from '../message-row/message-row.component';

/** A plain text message from Alice; a test passes every field its assertions read. */
export function messageView(over: Partial<MessageView> = {}): MessageView {
  return {
    id: '$1',
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: 'hello',
    html: null,
    timestamp: 1000,
    isOwn: false,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'text',
    media: null,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
    ...over,
  };
}

/** {@link messageView} as the first row of a group, with its header. */
export function messageRow(over: Partial<MessageRow> = {}): MessageRow {
  return { ...messageView(), showHeader: true, ...over };
}
