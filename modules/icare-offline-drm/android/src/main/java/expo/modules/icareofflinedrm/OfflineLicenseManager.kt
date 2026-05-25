package expo.modules.icareofflinedrm

import android.content.Context
import android.util.Base64
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.drm.DrmSessionEventListener
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback
import androidx.media3.exoplayer.drm.OfflineLicenseHelper
import androidx.media3.exoplayer.offline.DownloadHelper
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

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
      val helper = newOfflineHelper(licenseUrl = "", licenseToken = null)
      helper.releaseLicense(keySetId)
      helper.release()
    } catch (_: Throwable) { /* best-effort */ }
    prefs(ctx).edit().remove(KEY_PREFIX + downloadId).apply()
  }

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

    val httpFactory = DefaultHttpDataSource.Factory().setUserAgent("IcareLifeLearn/1.0")
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
      throw java.io.IOException("DownloadHelper prep timed out")
    errRef.get()?.let { throw it }

    val format = findDrmFormat(helper) ?: run {
      helper.release()
      throw IllegalStateException("No DRM Format found in $manifestUrl")
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

  private fun newOfflineHelper(licenseUrl: String, licenseToken: String?): OfflineLicenseHelper {
    val httpFactory = DefaultHttpDataSource.Factory().setUserAgent("IcareLifeLearn/1.0")
    val callback = HttpMediaDrmCallback(licenseUrl, httpFactory)
    if (!licenseToken.isNullOrEmpty()) {
      callback.setKeyRequestProperty("x-mux-license-token", licenseToken)
    }
    return OfflineLicenseHelper(
      androidx.media3.exoplayer.drm.DefaultDrmSessionManager.Builder()
        .setUuidAndExoMediaDrmProvider(
          androidx.media3.common.C.WIDEVINE_UUID,
          androidx.media3.exoplayer.drm.FrameworkMediaDrm.DEFAULT_PROVIDER,
        )
        .setMultiSession(false)
        .build(callback),
      DrmSessionEventListener.EventDispatcher(),
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
