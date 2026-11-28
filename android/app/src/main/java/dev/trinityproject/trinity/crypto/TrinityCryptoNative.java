package dev.trinityproject.trinity.crypto;

/** The JNI entry point of native/crypto (`libtrinity_crypto.so`, packaged by the Gradle build). */
final class TrinityCryptoNative {
    /** Whether the library loaded: false in a build made with `trinityNativeCrypto=false`. */
    static final boolean LOADED = load();

    private TrinityCryptoNative() {}

    private static boolean load() {
        try {
            System.loadLibrary("trinity_crypto");
            return true;
        } catch (UnsatisfiedLinkError error) {
            return false;
        }
    }

    /**
     * Runs one JSON request, or a JSON array of them, for one machine; blocks until done.
     * `init` opens `storePath` with `storeKey` (32 raw bytes) and is refused when either is
     * null. The caller wipes `storeKey` afterwards.
     */
    static native String call(String userId, String deviceId, String request, String storePath, byte[] storeKey);
}
