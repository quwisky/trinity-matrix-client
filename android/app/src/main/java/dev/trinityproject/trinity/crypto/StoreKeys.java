package dev.trinityproject.trinity.crypto;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A store's raw 32-byte key, kept only wrapped: AES-GCM under a wrapping key (on a phone a
 * non-exportable Android Keystore key), bound to its device by associated data. The raw key is
 * made on the store's first open and never leaves native code; callers wipe what they get.
 */
final class StoreKeys {
    static final int KEY_LENGTH = 32;
    private static final byte VERSION = 1;
    private static final int IV_LENGTH = 12;
    private static final int TAG_BITS = 128;

    /** The wrapping key could not be reached, or a wrapped key did not unwrap. */
    static final class KeyUnavailable extends Exception {
        KeyUnavailable(String message) {
            super(message);
        }
    }

    interface WrappingKey {
        SecretKey get() throws GeneralSecurityException;
    }

    private final WrappingKey wrappingKey;
    private final SecureRandom random;

    StoreKeys(WrappingKey wrappingKey, SecureRandom random) {
        this.wrappingKey = wrappingKey;
        this.random = random;
    }

    /**
     * The key of the store in `directory`, made and saved first when the store is new. An
     * existing store without its key is refused: a new key would not open it.
     */
    byte[] getOrCreate(File directory, byte[] associatedData) throws KeyUnavailable, IOException {
        File keyFile = new File(directory, CryptoStores.KEY_FILE);
        if (keyFile.exists()) {
            return unwrap(Files.readAllBytes(keyFile.toPath()), associatedData);
        }
        if (new File(directory, CryptoStores.DATABASE_FILE).exists()) {
            throw new KeyUnavailable("the store exists without its key");
        }
        byte[] key = new byte[KEY_LENGTH];
        random.nextBytes(key);
        try {
            write(keyFile, wrap(key, associatedData));
            return key;
        } catch (KeyUnavailable | IOException | RuntimeException error) {
            Arrays.fill(key, (byte) 0);
            throw error;
        }
    }

    byte[] wrap(byte[] key, byte[] associatedData) throws KeyUnavailable {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            // The provider picks the IV (the Keystore requires it).
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey.get());
            cipher.updateAAD(associatedData);
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(key);
            if (iv.length != IV_LENGTH) throw new KeyUnavailable("unexpected IV length");
            byte[] blob = new byte[1 + IV_LENGTH + sealed.length];
            blob[0] = VERSION;
            System.arraycopy(iv, 0, blob, 1, IV_LENGTH);
            System.arraycopy(sealed, 0, blob, 1 + IV_LENGTH, sealed.length);
            return blob;
        } catch (GeneralSecurityException error) {
            throw new KeyUnavailable("the store key could not be wrapped");
        }
    }

    byte[] unwrap(byte[] blob, byte[] associatedData) throws KeyUnavailable {
        if (blob.length != 1 + IV_LENGTH + KEY_LENGTH + TAG_BITS / 8 || blob[0] != VERSION) {
            throw new KeyUnavailable("the wrapped store key is malformed");
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey.get(), new GCMParameterSpec(TAG_BITS, blob, 1, IV_LENGTH));
            cipher.updateAAD(associatedData);
            return cipher.doFinal(blob, 1 + IV_LENGTH, blob.length - 1 - IV_LENGTH);
        } catch (GeneralSecurityException error) {
            throw new KeyUnavailable("the store key could not be unwrapped");
        }
    }

    /** Written beside the store, then renamed, so a crash never leaves half a key. */
    private static void write(File keyFile, byte[] blob) throws IOException {
        File directory = keyFile.getParentFile();
        if (directory != null && !directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("could not create the store directory");
        }
        File partial = new File(directory, CryptoStores.KEY_FILE + ".partial");
        try (FileOutputStream out = new FileOutputStream(partial)) {
            out.write(blob);
            out.getFD().sync();
        }
        if (!partial.renameTo(keyFile)) {
            partial.delete();
            throw new IOException("could not save the wrapped store key");
        }
    }
}
