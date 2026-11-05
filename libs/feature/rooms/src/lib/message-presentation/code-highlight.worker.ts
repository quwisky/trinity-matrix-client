import type {
  HighlightReply,
  HighlightRequest,
  HighlightStarted,
} from './code-highlight.client';
import { respond } from './code-highlight.respond';

/**
 * Tokenizes code blocks off the main thread. Replies carry runs, never markup: the main thread
 * builds the DOM and checks the text against the code it sent.
 */
const scope = self as unknown as {
  postMessage(message: HighlightReply | HighlightStarted): void;
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
};

scope.onmessage = ({ data }) => {
  void respond(data, (message) => scope.postMessage(message));
};
