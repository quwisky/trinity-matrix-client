package dev.trinityproject.trinity.crypto;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Where a machine's store lives: `<noBackupFilesDir>/crypto/<sha256(userId)>/<sha256(deviceId)>`,
 * the layout the Rust engine expects. The wrapped store key sits in the same directory, so
 * deleting the directory deletes both. `no_backup` is never backed up, and the manifest's
 * backup and data extraction rules exclude every domain from backup and device transfer.
 */
final class CryptoStores {
    static final String KEY_FILE = "store-key.wrapped";
    /** The file SQLite creates in the store directory (matrix-sdk-sqlite's crypto store). */
    static final String DATABASE_FILE = "matrix-sdk-crypto.sqlite3";

    private CryptoStores() {}

    static File directory(File noBackupDir, String userId, String deviceId) {
        return new File(new File(new File(noBackupDir, "crypto"), sha256(userId)), sha256(deviceId));
    }

    /** Binds a wrapped key to its device: the store's path below `no_backup`. */
    static byte[] associatedData(String userId, String deviceId) {
        return ("trinity-crypto-store-key/v1/" + sha256(userId) + "/" + sha256(deviceId)).getBytes(StandardCharsets.UTF_8);
    }

    /** Deletes a store directory and everything in it; nothing there is not an error. */
    static void delete(File directory) throws IOException {
        File[] children = directory.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) {
                    delete(child);
                } else if (!child.delete() && child.exists()) {
                    throw new IOException("could not delete a store file");
                }
            }
        }
        if (!directory.delete() && directory.exists()) {
            throw new IOException("could not delete the store directory");
        }
    }

    static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
