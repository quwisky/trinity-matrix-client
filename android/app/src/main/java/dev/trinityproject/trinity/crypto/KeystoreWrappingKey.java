package dev.trinityproject.trinity.crypto;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/**
 * The Android Keystore AES key that wraps every store key: non-exportable, and usable without
 * user authentication so a background sync can open a store. It never leaves the device, so a
 * wrapped key restored elsewhere cannot be opened (the manifest also excludes all app data from
 * backup and device transfer).
 */
final class KeystoreWrappingKey implements StoreKeys.WrappingKey {
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String ALIAS = "trinity-crypto-store-wrap";

    @Override
    public synchronized SecretKey get() throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance(PROVIDER);
        try {
            keyStore.load(null);
        } catch (java.io.IOException error) {
            throw new GeneralSecurityException("the keystore could not be loaded");
        }
        KeyStore.Entry entry = keyStore.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
        generator.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return generator.generateKey();
    }
}
