package expo.modules.icareofflinedrm

import android.content.Context
import android.util.Base64
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback
import androidx.media3.exoplayer.drm.OfflineLicenseHelper
import androidx.media3.exoplayer.hls.HlsManifest
import androidx.media3.exoplayer.offline.DownloadHelper
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Acquires & persists Widevine offline licenses. License keySetIds are stored
 * encrypted at rest with EncryptedSharedPreferences (AES-256-GCM under a key
 * managed by the Android Keystore).
 *
 * Mux's Widevine license endpoint expects the per-playback DRM token to be
 * sent via the `x-mux-license-token` header. We forward it on every license
 * request (initial + renewal).
 */
@UnstableApi
object OfflineLicenseManager {
  private const val PREFS_NAME = "icare_offline_drm"
  private const val KEY_PREFIX = "ksid_"

  private fun prefs(ctx: Context) =
    EncryptedSharedPreferences.create(
      ctx,
      PREFS_NAME,
      MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

  fun getKeySetIdB64(ctx: Context, downloadId: String): String? =
    prefs(ctx).getString(KEY_PREFIX + downloadId, null)

  fun release(ctx: Context, downloadId: String) {
    val b64 = getKeySetIdB64(ctx, downloadId) ?: return
    try {
      val keySetId = Base64.decode(b64, Base64.NO_WRAP)
      newOfflineHelper(licenseUrl = null, licenseToken = null).use { helper ->
        helper.releaseLicense(keySetId)
      }
    } catch (_: Throwable) { /* best-effort */ }
    prefs(ctx).edit().remove(KEY_PREFIX + downloadId).apply()
  }

  /**
   * Acquires an offline Widevine license for the given HLS manifest and
   * stores the keySetId for later playback.
   *
   * Strategy: download the HLS manifest via DownloadHelper → extract a
   * `Format` containing PSSH/DRM init data → call OfflineLicenseHelper.
   */
  fun acquireAndStore(
    ctx: Context,
    downloadId: String,
    manifestUrl: String,
    licenseUrl: String,
    licenseToken: String,
  ) {
    val mediaItem = MediaItem.Builder()
      .setMediaId(downloadId)
      .setUri(manifestUrl)
      .build()

    val httpFactory = DefaultHttpDataSource.Factory().setUserAgent("IcareLifeLearn-OfflineLic/1.0")
    val helper = DownloadHelper.forMediaItem(
      ctx, mediaItem, DefaultRenderersFactory(ctx), httpFactory,
    )

    val latch = java.util.concurrent.CountDownLatch(1)
    val errRef = java.util.concurrent.atomic.AtomicReference<Throwable?>()
    helper.prepare(object : DownloadHelper.Callback {
      override fun onPrepared(h: DownloadHelper) { latch.countDown() }
      override fun onPrepareError(h: DownloadHelper, e: java.io.IOException) {
        errRef.set(e); latch.countDown()
      }
    })
    if (!latch.await(30, java.util.concurrent.TimeUnit.SECONDS))
      throw java.io.IOException("DownloadHelper prep timed out (license)")
    errRef.get()?.let { throw it }

    // Pull a Format with DRM init data from one of the prepared periods.
    val format = findDrmFormat(helper) ?: run {
      helper.release()
      throw IllegalStateException("No DRM-protected Format found in manifest $manifestUrl")
    }

    val offlineHelper = newOfflineHelper(licenseUrl, licenseToken)
    val keySetId = try {
      offlineHelper.downloadLicense(format)
    } finally {
      offlineHelper.release()
      helper.release()
    }

    prefs(ctx).edit()
      .putString(KEY_PREFIX + downloadId, Base64.encodeToString(keySetId, Base64.NO_WRAP))
      .apply()
  }

  private fun newOfflineHelper(
    licenseUrl: String?,
    licenseToken: String?,
  ): OfflineLicenseHelper {
    val httpFactory = DefaultHttpDataSource.Factory().setUserAgent("IcareLifeLearn-OfflineLic/1.0")
    val callback = HttpMediaDrmCallback(licenseUrl ?: "", httpFactory)
    if (!licenseToken.isNullOrEmpty()) {
      // Mux convention: per-playback license token sent as a header.
      callback.setKeyRequestProperty("x-mux-license-token", licenseToken)
    }
    return OfflineLicenseHelper.newWidevineInstance(
      callback,
      androidx.media3.exoplayer.drm.DrmSessionEventListener.EventDispatcher(),
    )
  }

  private fun findDrmFormat(helper: DownloadHelper): androidx.media3.common.Format? {
    for (periodIdx in 0 until helper.periodCount) {
      val mappedTrackInfo = helper.getMappedTrackInfo(periodIdx)
      for (rendererIdx in 0 until mappedTrackInfo.rendererCount) {
        val groups = mappedTrackInfo.getTrackGroups(rendererIdx)
        for (g in 0 until groups.length) {
          val tg = groups[g]
          for (t in 0 until tg.length) {
            val f = tg.getFormat(t)
            if (f.drmInitData != null) return f
          }
        }
      }
    }
    return null
  }
}
