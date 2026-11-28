package dev.trinityproject.trinity.crypto;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.SecureRandom;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class StoreKeysTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private static StoreKeys keys(SecretKey wrapping) {
        return new StoreKeys(() -> wrapping, new SecureRandom());
    }

    private static SecretKey aes() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        return generator.generateKey();
    }

    private static final byte[] AAD = CryptoStores.associatedData("@a:example.org", "DEVICE");

    @Test
    public void aNewStoreGetsARandomKeyThatIsSavedOnlyWrapped() throws Exception {
        File dir = new File(folder.getRoot(), "store");
        StoreKeys keys = keys(aes());
        byte[] key = keys.getOrCreate(dir, AAD);
        assertEquals(32, key.length);
        byte[] saved = Files.readAllBytes(new File(dir, CryptoStores.KEY_FILE).toPath());
        assertEquals(1 + 12 + 32 + 16, saved.length);
        assertFalse("the raw key is not in the file", indexOf(saved, key) >= 0);
        assertFalse(new File(dir, CryptoStores.KEY_FILE + ".partial").exists());
        // Opened again, the same key comes back.
        assertArrayEquals(key, keys.getOrCreate(dir, AAD));
        assertFalse(java.util.Arrays.equals(key, keys(aes()).getOrCreate(new File(folder.getRoot(), "other"), AAD)));
    }

    @Test
    public void aKeyDoesNotUnwrapForAnotherDeviceOrWrappingKeyOrAfterTampering() throws Exception {
        SecretKey wrapping = aes();
        File dir = new File(folder.getRoot(), "store");
        keys(wrapping).getOrCreate(dir, AAD);
        byte[] other = CryptoStores.associatedData("@a:example.org", "OTHER");
        assertThrows(StoreKeys.KeyUnavailable.class, () -> keys(wrapping).getOrCreate(dir, other));
        assertThrows(StoreKeys.KeyUnavailable.class, () -> keys(aes()).getOrCreate(dir, AAD));
        File keyFile = new File(dir, CryptoStores.KEY_FILE);
        byte[] blob = Files.readAllBytes(keyFile.toPath());
        blob[20] ^= 1;
        Files.write(keyFile.toPath(), blob);
        assertThrows(StoreKeys.KeyUnavailable.class, () -> keys(wrapping).getOrCreate(dir, AAD));
        Files.write(keyFile.toPath(), new byte[] { 1, 2, 3 });
        assertThrows(StoreKeys.KeyUnavailable.class, () -> keys(wrapping).getOrCreate(dir, AAD));
    }

    @Test
    public void anExistingStoreWithoutItsKeyIsRefusedNotGivenANewKey() throws Exception {
        File dir = folder.newFolder("store");
        assertTrue(new File(dir, CryptoStores.DATABASE_FILE).createNewFile());
        assertThrows(StoreKeys.KeyUnavailable.class, () -> keys(aes()).getOrCreate(dir, AAD));
        assertFalse(new File(dir, CryptoStores.KEY_FILE).exists());
    }

    @Test
    public void anUnreachableWrappingKeyCreatesNothing() throws Exception {
        File dir = new File(folder.getRoot(), "store");
        StoreKeys broken = new StoreKeys(() -> { throw new java.security.KeyStoreException("locked"); }, new SecureRandom());
        assertThrows(StoreKeys.KeyUnavailable.class, () -> broken.getOrCreate(dir, AAD));
        assertFalse(new File(dir, CryptoStores.KEY_FILE).exists());
    }

    @Test
    public void deletingAStoreRemovesTheKeyAndIsIdempotent() throws Exception {
        File dir = CryptoStores.directory(folder.getRoot(), "@a:example.org", "DEVICE");
        keys(aes()).getOrCreate(dir, AAD);
        assertTrue(new File(dir, "nested").mkdir());
        assertTrue(new File(dir, CryptoStores.DATABASE_FILE).createNewFile());
        CryptoStores.delete(dir);
        assertFalse(dir.exists());
        CryptoStores.delete(dir);
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) if (haystack[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }
}
