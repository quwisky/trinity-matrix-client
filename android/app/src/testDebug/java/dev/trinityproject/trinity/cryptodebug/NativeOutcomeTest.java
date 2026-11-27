package dev.trinityproject.trinity.cryptodebug;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import org.junit.Test;

public class NativeOutcomeTest {

    @Test
    public void returnsTheResponse() {
        NativeOutcome outcome = NativeOutcome.of(request -> "echo " + request, "{}");
        assertEquals("echo {}", outcome.response);
        assertNull(outcome.error);
    }

    @Test
    public void anErrorFromAStaleLibraryBecomesTheOutcome() {
        UnsatisfiedLinkError missing = new UnsatisfiedLinkError("no callBatch in libtrinity_crypto.so");
        NativeOutcome outcome = NativeOutcome.of(request -> { throw missing; }, "{}");
        assertSame(missing, outcome.error);
        assertNull(outcome.response);
    }
}
