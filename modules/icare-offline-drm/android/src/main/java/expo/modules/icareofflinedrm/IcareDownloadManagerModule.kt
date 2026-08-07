package expo.modules.icareofflinedrm

import android.content.Context
import android.os.StatFs
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Small lifecycle companion for the Media3 download module.
 *
 * Deliberately does NOT own downloading, DRM, cache, or playback. It only stores
 * entitlement metadata for already-authorized downloads and exposes accurate
 * device-storage information for the React Native Download Manager UI.
 */
class IcareDownloadManagerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("IcareDownloadManager")

    AsyncFunction("getDeviceStorageStats") {
      val ctx = appContext.reactContext ?: return@AsyncFunction mapOf(
        "totalBytes" to 0.0,
        "freeBytes" to 0.0,
        "usedBytes" to 0.0,
      )
      val stat = StatFs(ctx.filesDir.absolutePath)
      val total = stat.totalBytes.coerceAtLeast(0L)
      val free = stat.availableBytes.coerceAtLeast(0L)
      mapOf(
        "totalBytes" to total.toDouble(),
        "freeBytes" to free.toDouble(),
        "usedBytes" to (total - free).coerceAtLeast(0L).toDouble(),
      )
    }

    AsyncFunction("setEntitlement") {
      id: String,
      courseId: String,
      chapterId: String,
      accessExpiresAt: String? ->
      val ctx = appContext.reactContext ?: return@AsyncFunction null
      val p = prefs(ctx)
      val e = p.edit()
        .putString(key("course", id), courseId)
        .putString(key("chapter", id), chapterId)
        .putString(key("validated", id), isoNow())
      if (accessExpiresAt.isNullOrBlank()) {
        e.remove(key("expires", id))
      } else {
        e.putString(key("expires", id), accessExpiresAt)
      }
      e.apply()
      null
    }

    AsyncFunction("getEntitlement") { id: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction emptyMap<String, Any?>()
      val p = prefs(ctx)
      mapOf(
        "courseId" to p.getString(key("course", id), null),
        "chapterId" to p.getString(key("chapter", id), null),
        "accessExpiresAt" to p.getString(key("expires", id), null),
        "validatedAt" to p.getString(key("validated", id), null),
      )
    }

    AsyncFunction("clearEntitlement") { id: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction null
      prefs(ctx).edit()
        .remove(key("course", id))
        .remove(key("chapter", id))
        .remove(key("expires", id))
        .remove(key("validated", id))
        .apply()
      null
    }
  }

  private fun prefs(ctx: Context) =
    ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun key(prefix: String, id: String) = "${prefix}_$id"

  private fun isoNow(): String {
    val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
    sdf.timeZone = TimeZone.getTimeZone("UTC")
    return sdf.format(java.util.Date())
  }

  companion object {
    private const val PREFS_NAME = "icare_download_entitlements"
  }
}
