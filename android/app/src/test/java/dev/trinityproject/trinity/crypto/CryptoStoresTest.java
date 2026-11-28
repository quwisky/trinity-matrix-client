package dev.trinityproject.trinity.crypto;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import java.io.File;
import org.junit.Test;

public class CryptoStoresTest {

    @Test
    public void theStoreLivesUnderNoBackupByHashedUserAndDevice() {
        File dir = CryptoStores.directory(new File("/data/no_backup"), "@alice:example.org", "ABCDEF");
        assertEquals(
            "/data/no_backup/crypto/" + CryptoStores.sha256("@alice:example.org") + "/" + CryptoStores.sha256("ABCDEF"),
            dir.getPath()
        );
        // SHA-256 of "abc", the FIPS 180-2 test vector.
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", CryptoStores.sha256("abc"));
    }

    @Test
    public void devicesAndUsersNeverShareAStore() {
        File root = new File("/r");
        assertNotEquals(CryptoStores.directory(root, "@a:x", "D1"), CryptoStores.directory(root, "@a:x", "D2"));
        assertNotEquals(CryptoStores.directory(root, "@a:x", "D1"), CryptoStores.directory(root, "@b:x", "D1"));
    }
}
