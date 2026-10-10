package dev.trinityproject.trinity.push

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONException
import org.json.JSONObject

/**
 * The push handoff store: per account its homeserver URL, access token and sound choice,
 * and its room names and DM flags. Written by PushHandoffPlugin, read by
 * TrinityMessagingService while the app is closed.
 *
 * Every value is AES-256-GCM encrypted with a non-exportable Android Keystore key before it
 * reaches the private SharedPreferences file. Writes report failure as `false` and never
 * log what they store.
 */
class PushHandoffStore internal constructor(
    private val preferences: SharedPreferences,
    private val crypto: ValueCrypto,
) : HandoffReader {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
        KeystoreCrypto(),
    )

    @Synchronized
    fun setAccount(userId: String, account: HandoffAccount): Boolean = write(
        accountKey(userId),
        JSONObject()
            .put("homeserverUrl", account.homeserverUrl)
            .put("accessToken", account.accessToken)
            .put("sound", account.sound),
    )

    /** Upserts the given rooms; rooms not listed keep their entries. */
    @Synchronized
    fun mergeRooms(userId: String, rooms: Map<String, HandoffRoom>): Boolean {
        val stored = read(roomsKey(userId)) ?: JSONObject()
        return try {
            for ((roomId, room) in rooms) {
                stored.put(roomId, JSONObject().put("name", room.name).put("direct", room.direct))
            }
            write(roomsKey(userId), stored)
        } catch (error: JSONException) {
            false
        }
    }

    @Synchronized
    fun removeAccount(userId: String): Boolean =
        preferences.edit().remove(accountKey(userId)).remove(roomsKey(userId)).commit()

    @Synchronized
    fun clear(): Boolean = preferences.edit().clear().commit()

    @Synchronized
    override fun account(userId: String): HandoffAccount? {
        val json = read(accountKey(userId)) ?: return null
        val homeserverUrl = PushRenderRules.stringOrNull(json, "homeserverUrl") ?: return null
        val accessToken = PushRenderRules.stringOrNull(json, "accessToken") ?: return null
        return HandoffAccount(homeserverUrl, accessToken, json.optBoolean("sound", true))
    }

    @Synchronized
    override fun room(userId: String, roomId: String): HandoffRoom? {
        val room = read(roomsKey(userId))?.optJSONObject(roomId) ?: return null
        val name = PushRenderRules.stringOrNull(room, "name") ?: return null
        return HandoffRoom(name, room.optBoolean("direct", false))
    }

    private fun write(key: String, value: JSONObject): Boolean = try {
        preferences.edit().putString(key, crypto.encrypt(value.toString())).commit()
    } catch (error: GeneralSecurityException) {
        false
    } catch (error: IOException) {
        false
    } catch (error: RuntimeException) {
        // The Keystore also throws ProviderException (and StrongBoxUnavailableException).
        false
    }

    private fun read(key: String): JSONObject? {
        val stored = preferences.getString(key, null) ?: return null
        return try {
            JSONObject(crypto.decrypt(stored))
        } catch (error: GeneralSecurityException) {
            null
        } catch (error: IOException) {
            null
        } catch (error: JSONException) {
            null
        } catch (error: RuntimeException) {
            null
        }
    }

    private fun accountKey(userId: String) = "account:$userId"

    private fun roomsKey(userId: String) = "rooms:$userId"

    private companion object {
        const val FILE = "trinity_push_handoff"
    }
}

/** Seals and opens stored values; failures surface as exceptions the store maps to false/null. */
internal interface ValueCrypto {
    fun encrypt(plain: String): String

    fun decrypt(stored: String): String
}

/** AES-256-GCM under a non-exportable Android Keystore key. */
internal class KeystoreCrypto : ValueCrypto {
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
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

    override fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    override fun decrypt(stored: String): String {
        val sealed = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
        return String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
    }

    private companion object {
        const val ALIAS = "trinity_push_handoff"
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
