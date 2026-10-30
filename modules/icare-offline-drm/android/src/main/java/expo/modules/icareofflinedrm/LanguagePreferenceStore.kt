package expo.modules.icareofflinedrm

import android.content.Context
import java.util.Locale

internal object LanguagePreferenceStore {
    private const val PREFS = "icare_language_preferences"
    private const val KEY_ORDERED = "ordered_language_codes"

    private fun normalize(code: String?): String {
        if (code.isNullOrBlank()) return ""
        val raw = code.trim().lowercase(Locale.ROOT)
        val base = raw.substringBefore('-').substringBefore('_')
        return when (base) {
            "eng" -> "en"
            "spa" -> "es"
            "swa" -> "sw"
            "hin" -> "hi"
            "mar" -> "mr"
            "guj" -> "gu"
            "tel" -> "te"
            "tam" -> "ta"
            "ben" -> "bn"
            "urd" -> "ur"
            "kan" -> "kn"
            "mal" -> "ml"
            "pan" -> "pa"
            "ori" -> "or"
            "asm" -> "as"
            else -> if (base.length == 2) base else base
        }
    }

    fun save(context: Context, codes: List<String>) {
        val ordered = codes
            .map(::normalize)
            .filter { it.isNotBlank() }
            .distinct()
            .take(3)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ORDERED, ordered.joinToString("|"))
            .apply()
        android.util.Log.d("IcareOfflineDrm", "preferred languages persisted=$ordered")
    }

    fun get(context: Context): List<String> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ORDERED, "")
            .orEmpty()
        return raw.split('|')
            .map(::normalize)
            .filter { it.isNotBlank() }
            .distinct()
            .take(3)
    }

    fun normalizeCode(code: String?): String = normalize(code)
}
