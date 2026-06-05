package expo.modules.icareofflinedrm

import android.content.Context
import android.media.MediaDrm
import android.util.Base64
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.DrmSessionEventListener
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback
import androidx.media3.exoplayer.drm.OfflineLicenseHelper
import androidx.media3.exoplayer.offline.DownloadHelper
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

@UnstableApi
object OfflineLicenseManager {
  private const val PREFS_NAME = "icare_offline_drm"
  private const val KEY_PREFIX = "ksid_"

  // Widevine DRM UUID (EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED).
  // Using longs to avoid UUID.fromString() on older API levels.
  private val WIDEVINE_UUID = UUID(-0x121074a6L, -0x5c37d8dbL)

  /**
   * Returns true if the device's Widevine DRM HAL is available and functional.
   * Fails fast — no network calls, no 30 s hangs.
   */
  fun isWidevineAvailable(): Boolean =
    try { MediaDrm.isCryptoSchemeSupported(WIDEVINE_UUID) } catch (_: Throwable) { false }

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
    // Fast-fail: if Widevine DRM is unavailable on this device (not provisioned,
    // HAL missing, or security-level check failing) throw immediately instead of
    // waiting 30 s for DownloadHelper.prepare() to time out.
    if (!isWidevineAvailable()) {
      throw IllegalStateException(
        "Widevine DRM is not available on this device — offline download of DRM-protected content is not supported"
      )
    }

    val httpFactory = DefaultHttpDataSource.Factory().setUserAgent("IcareLifeLearn/1.0")

    // Attach Widevine DRM configuration to the MediaItem so ExoPlayer's
    // DownloadHelper can properly initialise the DRM session during prepare().
    // Without this, ExoPlayer encounters the PSSH/DRM init data in the Mux HLS
    // manifest and hangs waiting for a license server that was never configured,
    // causing the 30 s "DownloadHelper prep timed out" error.
    val drmConfigBuilder = MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID)
      .setLicenseUri(licenseUrl)
    if (licenseToken.isNotEmpty()) {
      drmConfigBuilder.setLicenseRequestHeaders(mapOf("x-mux-license-token" to licenseToken))
    }
    val mediaItem = MediaItem.Builder()
      .setMediaId(downloadId)
      .setUri(manifestUrl)
      .setDrmConfiguration(drmConfigBuilder.build())
      .build()

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
