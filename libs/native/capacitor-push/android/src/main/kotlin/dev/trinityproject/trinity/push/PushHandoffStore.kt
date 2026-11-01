package dev.trinityproject.trinity.push

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.KeyStoreException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONException
import org.json.JSONObject

/**
 * App lock's Notification text as the app mirrored it; see the Swift `NotificationTextMode`.
 * Missing reads as [SHOW]; anything unreadable as [ALWAYS_HIDE].
 */
object NotificationTextMode {
    const val SHOW = "show"
    const val HIDE_ON_LOCK_SCREEN = "hide-on-lock-screen"
    const val ALWAYS_HIDE = "always-hide"
    val ALL = setOf(SHOW, HIDE_ON_LOCK_SCREEN, ALWAYS_HIDE)
}

/**
 * The push handoff store: per account its homeserver URL, access token (with its expiry,
 * when it has one) and sound choice, its room names and DM flags, and App lock's
 * Notification text; an OAuth account's token and expiry come from the token vault instead. Written by
 * PushHandoffPlugin, read by TrinityMessagingService while the app is closed.
 *
 * Every value is AES-256-GCM encrypted with a non-exportable Android Keystore key before it
 * reaches the private SharedPreferences file. Writes report failure as `false` and never
 * log what they store.
 */
class PushHandoffStore internal constructor(
    private val preferences: SharedPreferences,
    private val crypto: ValueCrypto,
    private val tokens: TokenVault,
) : HandoffReader {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
        KeystoreCrypto(KEY_ALIAS),
        KeystoreTokenVault(context),
    )

    @Synchronized
    fun setAccount(userId: String, account: HandoffAccount): Boolean = write(
        accountKey(userId),
        JSONObject()
            .put("homeserverUrl", account.homeserverUrl)
            .put("accessToken", account.accessToken)
            .put("sound", account.sound)
            .apply { account.accessTokenExpiresAt?.let { put("accessTokenExpiresAt", it) } },
    )

    /** Upserts the given rooms; rooms not listed keep their entries. */
    @Synchronized
    fun mergeRooms(userId: String, rooms: Map<String, HandoffRoom>): Boolean {
        val stored = read(roomsKey(userId)) ?: JSONObject()
        return try {
            for ((roomId, room) in rooms) {
                stored.put(
                    roomId,
                    JSONObject().put("name", room.name).put("direct", room.direct).put("encrypted", room.encrypted),
                )
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

    /** Stores App lock's effective Notification text; refuses a mode it doesn't know. */
    @Synchronized
    fun setNotificationText(mode: String): Boolean =
        mode in NotificationTextMode.ALL && write(SETTINGS_KEY, JSONObject().put("notificationText", mode))

    /** Missing reads as Show; anything unreadable as Always hide, so damage never reveals text. */
    @Synchronized
    override fun notificationText(): String {
        if (!preferences.contains(SETTINGS_KEY)) return NotificationTextMode.SHOW
        val mode = read(SETTINGS_KEY)?.let { PushRenderRules.stringOrNull(it, "notificationText") }
        return if (mode != null && mode in NotificationTextMode.ALL) mode else NotificationTextMode.ALWAYS_HIDE
    }

    @Synchronized
    override fun account(userId: String): HandoffAccount? {
        val json = read(accountKey(userId)) ?: return null
        val homeserverUrl = PushRenderRules.stringOrNull(json, "homeserverUrl") ?: return null
        val accessToken = PushRenderRules.stringOrNull(json, "accessToken") ?: ""
        return HandoffAccount(
            homeserverUrl,
            accessToken,
            json.optBoolean("sound", true),
            accessTokenExpiryFrom(json.opt("accessTokenExpiresAt")),
        ).overlaidBy(tokens.read(userId))
    }

    @Synchronized
    override fun room(userId: String, roomId: String): HandoffRoom? {
        val room = read(roomsKey(userId))?.optJSONObject(roomId) ?: return null
        val name = PushRenderRules.stringOrNull(room, "name") ?: return null
        return HandoffRoom(name, room.optBoolean("direct", false), room.optBoolean("encrypted", true))
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

    internal companion object {
        const val FILE = "trinity_push_handoff"
        const val KEY_ALIAS = "trinity_push_handoff"
        private const val SETTINGS_KEY = "settings:notification-text"
    }
}

/**
 * A token expiry as epoch milliseconds from any JSON number: the plugin call's value, or the
 * stored one. Capacitor's `getLong` reads only numbers parsed as Long, so a whole number
 * that fits an Integer, or one with a fraction, would otherwise be dropped. Null for
 * anything else, including a non-positive or non-finite number: a bad value must not make
 * every push read as expired.
 */
fun accessTokenExpiryFrom(raw: Any?): Long? {
    val number = raw as? Number ?: return null
    if (!number.toDouble().isFinite()) return null
    return number.toLong().takeIf { it > 0 }
}

/** Seals and opens stored values; failures surface as exceptions the store maps to false/null. */
internal interface ValueCrypto {
    fun encrypt(plain: String): String

    fun decrypt(stored: String): String
}

/** AES-256-GCM under a non-exportable Android Keystore key. */
internal class KeystoreCrypto(
    private val alias: String,
    private val storedKey: (String) -> SecretKey? = { keystoreKey(it) },
    private val newKey: (String) -> SecretKey = { generateKeystoreKey(it) },
) : ValueCrypto {
    override fun encrypt(plain: String): String {
        val key = synchronized(KEY_LOCK) { storedKey(alias) ?: newKey(alias) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    override fun decrypt(stored: String): String {
        // A read never generates. A lookup can report a transient Keystore fault as "no such
        // alias" (getKeyMetadata answers null on any KeyStoreException), and generating then
        // would replace the key and destroy every value sealed under it.
        val key = synchronized(KEY_LOCK) { storedKey(alias) } ?: throw KeyStoreException("No sealing key")
        val sealed = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
        return String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128

        // Shared by instances: each store and vault builds its own, and a second generation
        // over the alias would replace the key the first one sealed with.
        private val KEY_LOCK = Any()

        fun keystoreKey(alias: String): SecretKey? {
            val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            return (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.secretKey
        }

        fun generateKeystoreKey(alias: String): SecretKey {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            generator.init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return generator.generateKey()
        }
    }
}
