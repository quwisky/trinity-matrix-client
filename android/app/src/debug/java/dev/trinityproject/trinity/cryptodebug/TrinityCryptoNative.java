package dev.trinityproject.trinity.cryptodebug;

/** The JNI entry points of native/crypto (`libtrinity_crypto.so`, built by build-android.sh). */
final class TrinityCryptoNative {
    /** Why the library did not load, or null when it did. */
    static final String LOAD_ERROR = load();

    private TrinityCryptoNative() {}

    private static String load() {
        try {
            System.loadLibrary("trinity_crypto");
            return null;
        } catch (UnsatisfiedLinkError error) {
            return error.getMessage();
        }
    }

    /** Runs one JSON request; blocks until it is done. */
    static native String call(String request);

    /** Runs a JSON array of requests in order; blocks until they are done. */
    static native String callBatch(String requests);
}
