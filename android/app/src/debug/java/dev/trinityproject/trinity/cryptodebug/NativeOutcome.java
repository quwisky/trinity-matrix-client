package dev.trinityproject.trinity.cryptodebug;

import java.util.function.UnaryOperator;

/** What one native call produced: its response and time, or the throwable that ended it. */
final class NativeOutcome {
    final String response;
    final double nativeMs;
    final Throwable error;

    private NativeOutcome(String response, double nativeMs, Throwable error) {
        this.response = response;
        this.nativeMs = nativeMs;
        this.error = error;
    }

    static NativeOutcome of(UnaryOperator<String> nativeCall, String request) {
        long started = System.nanoTime();
        try {
            String response = nativeCall.apply(request);
            return new NativeOutcome(response, (System.nanoTime() - started) / 1e6, null);
        } catch (Throwable error) {
            // Errors too: a stale library without a method throws UnsatisfiedLinkError, which
            // would end the executor thread and leave the JS call unsettled.
            return new NativeOutcome(null, 0, error);
        }
    }
}
