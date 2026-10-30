import { Injectable } from '@angular/core';
import type { ConversationKey } from './conversation-messages';

type ContextResolver = () => ConversationKey | null;

/**
 * Internal bridge from the focused Conversation child to its data-access action adapter.
 *
 * This service is intentionally absent from the package barrel: feature code receives
 * app-owned timeline state and commands, while TimelineActionsService alone resolves the
 * account and room those commands act on.
 */
@Injectable({ providedIn: 'root' })
export class ConversationActionContextService {
  private resolver: ContextResolver | null = null;

  bind(resolver: ContextResolver): void {
    this.resolver = resolver;
  }

  clear(resolver: ContextResolver): void {
    if (this.resolver === resolver) {
      this.resolver = null;
    }
  }

  resolve(): ConversationKey | null {
    return this.resolver?.() ?? null;
  }
}
