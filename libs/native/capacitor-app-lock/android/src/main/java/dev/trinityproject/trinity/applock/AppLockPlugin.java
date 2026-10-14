package dev.trinityproject.trinity.applock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONObject;

/**
 * The App lock PIN verifier for the web layer (AppLockPinBridge in @trinity/capacitor-app-lock).
 * The PIN arrives once per call and is never logged, stored or returned; errors carry stable
 * codes only (every storage failure, read, write or delete, is `storage-unavailable`). Work runs
 * off the main thread on one worker, one call at a time: PBKDF2 takes a few hundred milliseconds.
 *
 * `cap sync` registers this class from the @trinity/capacitor-app-lock package. The Capacitor
 * CLI finds it only with the annotation at the start of a line, followed by the class.
 */
@CapacitorPlugin(name = "TrinityAppLock")
public class AppLockPlugin extends Plugin {
    private static final String STORAGE_UNAVAILABLE = "storage-unavailable";
    private static final String UNAVAILABLE_MESSAGE = "Secure storage is unavailable";
    private static final String PIN_INVALID = "pin-invalid";
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private PinVerifier verifier;

    @Override
    public void load() {
        verifier = new PinVerifier(new KeystorePinStore(getContext()));
    }

    @Override
    protected void handleOnDestroy() {
        // Calls already queued still finish and save their record.
        work.shutdown();
    }

    @PluginMethod
    public void pinStatus(PluginCall call) {
        submit(call, () -> {
            PinStatus status = verifier.status();
            if (status instanceof PinStatus.Ready ready) {
                JSObject result = new JSObject();
                result.put("set", ready.getSet());
                result.put("nextAttemptAt", orNull(ready.getNextAttemptAt()));
                call.resolve(result);
            } else {
                call.reject(UNAVAILABLE_MESSAGE, STORAGE_UNAVAILABLE);
            }
        });
    }

    @PluginMethod
    public void setPin(PluginCall call) {
        String pin = call.getString("pin");
        if (pin == null) {
            call.reject("Must provide pin", PIN_INVALID);
            return;
        }
        submit(call, () -> {
            switch (verifier.set(pin)) {
                case COMPLETED -> call.resolve();
                case INVALID -> call.reject("The PIN must be 4 to 16 digits", PIN_INVALID);
                default -> call.reject(UNAVAILABLE_MESSAGE, STORAGE_UNAVAILABLE);
            }
        });
    }

    @PluginMethod
    public void verifyPin(PluginCall call) {
        // A missing PIN goes through the verifier as an empty one, so it meets the same order as
        // any malformed PIN: an unreadable record is unavailable, otherwise it is invalid.
        String pin = call.getString("pin", "");
        submit(call, () -> {
            PinCheck check = verifier.verify(pin);
            String name;
            Object next = JSONObject.NULL;
            if (check instanceof PinCheck.Verified) {
                name = "verified";
            } else if (check instanceof PinCheck.Failed failed) {
                name = "failed";
                next = orNull(failed.getNextAttemptAt());
            } else if (check instanceof PinCheck.Delayed delayed) {
                name = "delayed";
                next = delayed.getNextAttemptAt();
            } else if (check instanceof PinCheck.Invalid) {
                name = "invalid";
            } else {
                name = "unavailable";
            }
            JSObject result = new JSObject();
            result.put("result", name);
            result.put("nextAttemptAt", next);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void clearPin(PluginCall call) {
        submit(call, () -> {
            if (verifier.clear()) {
                call.resolve();
            } else {
                call.reject(UNAVAILABLE_MESSAGE, STORAGE_UNAVAILABLE);
            }
        });
    }

    /**
     * Runs a call on the worker. Anything unexpected is answered as `storage-unavailable` with
     * fixed text, never the error's own message, so no call is left waiting.
     */
    private void submit(PluginCall call, Runnable task) {
        try {
            work.execute(() -> {
                try {
                    task.run();
                } catch (RuntimeException error) {
                    call.reject(UNAVAILABLE_MESSAGE, STORAGE_UNAVAILABLE);
                }
            });
        } catch (RejectedExecutionException error) {
            call.reject(UNAVAILABLE_MESSAGE, STORAGE_UNAVAILABLE);
        }
    }

    private static Object orNull(Double value) {
        return value == null ? JSONObject.NULL : value;
    }
}
