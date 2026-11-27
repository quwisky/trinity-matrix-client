package dev.trinityproject.trinity.cryptodebug;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.UnaryOperator;

/**
 * Debug builds only: the native crypto crate's JSON surface over the bridge. `call` takes
 * `{ request }`, `callBatch` takes `{ requests }` (JSON strings); both resolve
 * `{ response, nativeMs }`, the crate's JSON response and the time spent in the native call.
 */
@CapacitorPlugin(name = "TrinityCryptoDebug")
public class TrinityCryptoDebugPlugin extends Plugin {
    /** A native call blocks its thread, so calls run here, one at a time, never on the main thread. */
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(
        runnable -> new Thread(runnable, "trinity-crypto-debug")
    );

    @PluginMethod
    public void call(PluginCall call) {
        run(call, "request", TrinityCryptoNative::call);
    }

    @PluginMethod
    public void callBatch(PluginCall call) {
        run(call, "requests", TrinityCryptoNative::callBatch);
    }

    private static void run(PluginCall call, String argument, UnaryOperator<String> nativeCall) {
        String request = call.getString(argument);
        if (request == null) {
            call.reject(argument + " is required");
            return;
        }
        if (TrinityCryptoNative.LOAD_ERROR != null) {
            call.reject("native crypto not built (run native/crypto/build-android.sh)", "NOT_BUILT");
            return;
        }
        EXECUTOR.execute(() -> {
            NativeOutcome outcome = NativeOutcome.of(nativeCall, request);
            if (outcome.error != null) {
                call.reject("native crypto call failed: " + outcome.error, "NATIVE_ERROR");
                return;
            }
            JSObject result = new JSObject();
            result.put("response", outcome.response);
            result.put("nativeMs", outcome.nativeMs);
            call.resolve(result);
        });
    }
}
