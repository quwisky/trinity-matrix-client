package dev.trinityproject.trinity.crypto;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * One background thread per machine (user and device), so a stuck machine holds up only its
 * own calls, each with a bounded queue. Idle threads end after a while and come back on demand.
 */
final class MachineExecutors {
    static final int QUEUE_CAPACITY = 64;
    private static final long IDLE_SECONDS = 60;

    private final Map<String, ThreadPoolExecutor> executors = new HashMap<>();
    private final int capacity;

    MachineExecutors(int capacity) {
        this.capacity = capacity;
    }

    /** Runs `task` after the machine's earlier tasks; false when its queue is full. */
    synchronized boolean submit(String userId, String deviceId, Runnable task) {
        String key = userId + "\n" + deviceId;
        ThreadPoolExecutor executor = executors.get(key);
        if (executor == null) {
            executor = new ThreadPoolExecutor(
                1,
                1,
                IDLE_SECONDS,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(capacity),
                runnable -> {
                    Thread thread = new Thread(runnable, "trinity-crypto-machine");
                    thread.setDaemon(true);
                    return thread;
                }
            );
            executor.allowCoreThreadTimeOut(true);
            executors.put(key, executor);
        }
        try {
            executor.execute(task);
            return true;
        } catch (RejectedExecutionException full) {
            return false;
        }
    }
}
