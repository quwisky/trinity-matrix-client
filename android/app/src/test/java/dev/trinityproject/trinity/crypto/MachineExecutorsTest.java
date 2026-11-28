package dev.trinityproject.trinity.crypto;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class MachineExecutorsTest {

    @Test
    public void aStuckMachineHoldsUpOnlyItsOwnCallsAndItsQueueIsBounded() throws Exception {
        MachineExecutors executors = new MachineExecutors(2);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch other = new CountDownLatch(1);
        assertTrue(executors.submit("@a:x", "D", () -> await(release)));
        // Running one, two waiting: the third is refused.
        assertTrue(executors.submit("@a:x", "D", () -> {}));
        assertTrue(executors.submit("@a:x", "D", () -> {}));
        assertFalse(executors.submit("@a:x", "D", () -> {}));
        // Another machine (here the same user's other device) runs meanwhile.
        assertTrue(executors.submit("@a:x", "E", other::countDown));
        assertTrue(other.await(5, TimeUnit.SECONDS));
        release.countDown();
    }

    @Test
    public void callsOfOneMachineRunInOrder() throws Exception {
        MachineExecutors executors = new MachineExecutors(8);
        StringBuffer order = new StringBuffer();
        CountDownLatch done = new CountDownLatch(1);
        for (int i = 0; i < 5; i++) {
            int n = i;
            assertTrue(executors.submit("@a:x", "D", () -> order.append(n)));
        }
        assertTrue(executors.submit("@a:x", "D", done::countDown));
        assertTrue(done.await(5, TimeUnit.SECONDS));
        assertTrue(order.toString().equals("01234"));
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
