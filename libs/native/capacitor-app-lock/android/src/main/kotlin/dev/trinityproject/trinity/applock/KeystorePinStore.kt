package dev.trinityproject.trinity.applock

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The verifier record in a private SharedPreferences file, AES-256-GCM encrypted under a
 * non-exportable Android Keystore key (as PushHandoffStore keeps its values; its crypto is
 * internal to the push module). The host excludes every SharedPreferences file from backup
 * and device transfer, so the record never reaches a device without its key.
 *
 * Only a missing entry reads as "no record". Every other failure throws a PinStoreException
 * with fixed text and no cause, which the verifier reports as unavailable.
 */
class KeystorePinStore(context: Context) : PinRecordStore {
    private val preferences: SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    override fun read(): String? {
        val stored = try {
            preferences.getString(KEY, null)
        } catch (error: Exception) {
            // A value of another type under the key.
            throw PinStoreException.Unreadable()
        }
        if (stored == null) return null
        try {
            val sealed = Base64.decode(stored, Base64.NO_WRAP)
            // A record without its key (the Keystore entry is gone) cannot be read; reading never
            // makes a new key, so it never hides that.
            val key = existingKey() ?: throw PinStoreException.Unreadable()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
            return String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
        } catch (error: Exception) {
            throw PinStoreException.Unreadable()
        }
    }

    override fun write(value: String) {
        val stored = try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: newKey())
            check(cipher.iv.size == IV_BYTES)
            Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        } catch (error: Exception) {
            throw PinStoreException.WriteFailed()
        }
        val saved = try {
            preferences.edit().putString(KEY, stored).commit()
        } catch (error: Exception) {
            false
        }
        if (!saved) throw PinStoreException.WriteFailed()
    }

    /**
     * Removes the record, then the key as well, so the full reset also recovers from a damaged
     * Keystore entry; the next write makes a new key. Only the record's removal must succeed.
     */
    override fun remove() {
        val removed = try {
            preferences.edit().remove(KEY).commit()
        } catch (error: Exception) {
            false
        }
        if (!removed) throw PinStoreException.DeleteFailed()
        try {
            keyStore().deleteEntry(ALIAS)
        } catch (error: Exception) {
            // The record is gone, which is all the reset needs; the next write reuses this key.
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey

    private fun newKey(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val FILE = "trinity_app_lock"
        const val KEY = "pin-verifier"
        const val ALIAS = "trinity_app_lock"
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
