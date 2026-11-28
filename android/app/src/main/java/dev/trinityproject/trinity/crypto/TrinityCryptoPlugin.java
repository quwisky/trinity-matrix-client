package dev.trinityproject.trinity.crypto;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.regex.Pattern;

/**
 * The native crypto crate for the app's JavaScript shim. `call` and `callBatch` take one
 * machine's JSON request or batch and resolve `{ response }`, the crate's JSON; the plugin
 * opens that machine's store itself (path and Keystore-wrapped key, never from or to
 * JavaScript). Errors carry a fixed message and a code, never request or answer text.
 */
@CapacitorPlugin(name = "TrinityCrypto")
public class TrinityCryptoPlugin extends Plugin {
    static final String NOT_BUILT = "NotBuilt";
    static final String INVALID_ARGUMENTS = "InvalidArguments";
    static final String QUEUE_FULL = "QueueFull";
    static final String KEY_UNAVAILABLE = "KeyUnavailable";
    static final String STORE_UNAVAILABLE = "StoreUnavailable";
    static final String NATIVE_ERROR = "NativeError";

    /**
     * Requests that may hold an `init`, which needs the store key. Only a hint to skip unwrapping
     * the key for every other batch: an `init` it misses gets no store and the crate refuses it.
     */
    private static final Pattern INIT = Pattern.compile("\"method\"\\s*:\\s*\"init\"");

    private static final MachineExecutors EXECUTORS = new MachineExecutors(MachineExecutors.QUEUE_CAPACITY);
    private StoreKeys storeKeys;

    @Override
    public void load() {
        storeKeys = new StoreKeys(new KeystoreWrappingKey(), new SecureRandom());
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", TrinityCryptoNative.LOADED);
        call.resolve(result);
    }

    @PluginMethod
    public void call(PluginCall call) {
        run(call, "request");
    }

    @PluginMethod
    public void callBatch(PluginCall call) {
        run(call, "requests");
    }

    /** Closes the machine, then deletes its store and wrapped key; nothing there is success. */
    @PluginMethod
    public void deleteStore(PluginCall call) {
        String userId = call.getString("userId");
        String deviceId = call.getString("deviceId");
        if (userId == null || deviceId == null) {
            call.reject("userId and deviceId are required", INVALID_ARGUMENTS);
            return;
        }
        File directory = CryptoStores.directory(getContext().getNoBackupFilesDir(), userId, deviceId);
        submit(call, userId, deviceId, () -> {
            if (TrinityCryptoNative.LOADED) {
                try {
                    TrinityCryptoNative.call(userId, deviceId, closeRequest(userId, deviceId), null, null);
                } catch (Throwable ignored) {
                    // The files go anyway; a machine left open on them fails its next call.
                }
            }
            try {
                CryptoStores.delete(directory);
            } catch (java.io.IOException error) {
                call.reject("the store could not be deleted", STORE_UNAVAILABLE);
                return;
            }
            call.resolve();
        });
    }

    private void run(PluginCall call, String argument) {
        String userId = call.getString("userId");
        String deviceId = call.getString("deviceId");
        String request = call.getString(argument);
        if (userId == null || deviceId == null || request == null) {
            call.reject("userId, deviceId and " + argument + " are required", INVALID_ARGUMENTS);
            return;
        }
        if (!TrinityCryptoNative.LOADED) {
            call.reject("native crypto is not in this build", NOT_BUILT);
            return;
        }
        File directory = CryptoStores.directory(getContext().getNoBackupFilesDir(), userId, deviceId);
        submit(call, userId, deviceId, () -> {
            byte[] key = null;
            try {
                if (INIT.matcher(request).find()) {
                    key = storeKeys.getOrCreate(directory, CryptoStores.associatedData(userId, deviceId));
                }
                String response = TrinityCryptoNative.call(userId, deviceId, request, directory.getPath(), key);
                JSObject result = new JSObject();
                result.put("response", response);
                call.resolve(result);
            } catch (StoreKeys.KeyUnavailable error) {
                call.reject("the store key is unavailable", KEY_UNAVAILABLE);
            } catch (java.io.IOException error) {
                call.reject("the store could not be opened", STORE_UNAVAILABLE);
            } catch (Throwable error) {
                // Errors too: a stale library throws UnsatisfiedLinkError, which would end the thread.
                call.reject("the native call failed", NATIVE_ERROR);
            } finally {
                if (key != null) Arrays.fill(key, (byte) 0);
            }
        });
    }

    private static void submit(PluginCall call, String userId, String deviceId, Runnable task) {
        if (!EXECUTORS.submit(userId, deviceId, task)) {
            call.reject("too many calls are waiting for this machine", QUEUE_FULL);
        }
    }

    static String closeRequest(String userId, String deviceId) {
        JSObject request = new JSObject();
        request.put("method", "close");
        request.put("userId", userId);
        request.put("deviceId", deviceId);
        return request.toString();
    }
}
