import {
  ClientWidgetApi,
  PostmessageTransport,
  Widget,
  WidgetApiDirection,
  WidgetApiFromWidgetAction,
} from 'matrix-widget-api';
import { describe, expect, it, vi } from 'vitest';
import { RestrictedWidgetDriver } from './widget-bridge.service';

function inboundWindow() {
  let listener: ((event: MessageEvent) => void) | null = null;
  return {
    addEventListener: vi.fn(
      (_type: string, next: (event: MessageEvent) => void) => {
        listener = next;
      },
    ),
    removeEventListener: vi.fn(),
    emit: (event: MessageEvent) => listener?.(event),
  };
}

describe('matrix-widget-api transport hardening', () => {
  it('accepts messages only from its target window and target origin', () => {
    const targetWindow = { postMessage: vi.fn() };
    const attackerWindow = { postMessage: vi.fn() };
    const inbound = inboundWindow();
    const transport = new PostmessageTransport(
      WidgetApiDirection.ToWidget,
      'board',
      targetWindow as unknown as Window,
      inbound as unknown as Window,
    );
    transport.targetOrigin = 'https://widgets.example';
    const received = vi.fn();
    transport.on('message', received);
    transport.start();
    const data = {
      api: WidgetApiDirection.FromWidget,
      widgetId: 'board',
      requestId: 'request-1',
      action: WidgetApiFromWidgetAction.ContentLoaded,
      data: {},
    };

    inbound.emit({
      data,
      origin: 'https://widgets.example',
      source: attackerWindow,
    } as unknown as MessageEvent);
    inbound.emit({
      data,
      origin: 'https://attacker.example',
      source: targetWindow,
    } as unknown as MessageEvent);
    expect(received).not.toHaveBeenCalled();

    inbound.emit({
      data,
      origin: 'https://widgets.example',
      source: targetWindow,
    } as unknown as MessageEvent);
    expect(received).toHaveBeenCalledOnce();
  });

  it('removes the iframe load listener when the client API stops', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const removeEventListener = vi.spyOn(iframe, 'removeEventListener');
    const api = new ClientWidgetApi(
      new Widget({
        id: 'board',
        creatorUserId: '@alice:example.org',
        type: 'm.custom',
        url: 'https://widgets.example/board',
        waitForIframeLoad: true,
      }),
      iframe,
      new RestrictedWidgetDriver(),
    );

    api.stop();

    expect(removeEventListener).toHaveBeenCalledWith(
      'load',
      expect.any(Function),
    );
    iframe.remove();
  });
});
