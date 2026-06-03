package expo.modules.icareofflinedrm

import android.content.Context
import android.content.SharedPreferences
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Stores lightweight metadata (title, completion timestamp) for each download.
 * Uses plain SharedPreferences — this data is not sensitive (no keys or tokens).
 * Keyed by download ID (chapterId).
 */
object DownloadMetadata {
  private const val PREFS_NAME = "icare_download_meta"
  private const val PREFIX_TITLE = "title_"
  private const val PREFIX_COMPLETED_AT = "completed_at_"

  private fun prefs(ctx: Context): SharedPreferences =
    ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  fun saveTitle(ctx: Context, id: String, title: String) {
    prefs(ctx).edit().putString(PREFIX_TITLE + id, title).apply()
  }

  fun getTitle(ctx: Context, id: String): String? =
    prefs(ctx).getString(PREFIX_TITLE + id, null)

  fun removeTitle(ctx: Context, id: String) {
    prefs(ctx).edit().remove(PREFIX_TITLE + id).apply()
  }

  /** Records the completion timestamp only if not already stored. */
  fun ensureCompletedAt(ctx: Context, id: String) {
    val key = PREFIX_COMPLETED_AT + id
    val p = prefs(ctx)
    if (p.contains(key)) return
    val iso = isoNow()
    p.edit().putString(key, iso).apply()
  }

  fun getCompletedAt(ctx: Context, id: String): String? =
    prefs(ctx).getString(PREFIX_COMPLETED_AT + id, null)

  fun removeCompletedAt(ctx: Context, id: String) {
    prefs(ctx).edit().remove(PREFIX_COMPLETED_AT + id).apply()
  }

  private fun isoNow(): String {
    val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
    sdf.timeZone = TimeZone.getTimeZone("UTC")
    return sdf.format(Date())
  }
}
