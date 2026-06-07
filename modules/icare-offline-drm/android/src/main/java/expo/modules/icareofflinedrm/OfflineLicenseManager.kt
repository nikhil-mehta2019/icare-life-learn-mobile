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

@UnstableApi
object OfflineLicenseManager {
  private const val PREFS_NAME = "icare_offline_drm"
  private const val KEY_PREFIX = "ksid_"

  /**
   * Returns true if the device's Widevine DRM HAL is available and functional.
   *
   * Three-level probe — each level catches a different failure mode seen on MIUI/Xiaomi:
   *
   * Level 1 — MediaDrm constructor:
   *   Catches cases where the Widevine UUID is entirely absent from the framework.
   *
   * Level 2 — openSession():
   *   The constructor can succeed even when the HIDL Widevine factory reports
   *   "No supported hal instance found" (Android catches the HIDL/AIDL errors internally
   *   and returns a stub object). openSession() forces the HAL to create a real DRM context
   *   and throws NotProvisionedException / ResourceBusyException / MediaDrmException if the
   *   session can't actually be established.
   *
   * Level 3 — getPropertyString("securityLevel"):
   *   Reads a HAL property over the established session. Exercises the DRM ↔ HAL IPC path
   *   one more time; a broken HAL may throw here even if openSession() passes.
   *
   * All three must succeed for the device to be considered Widevine-capable.
   * If any level throws, we return false and the download is immediately rejected with a
   * clear error instead of hanging for 30 s inside DownloadHelper.prepare().
   */
  fun isWidevineAvailable(): Boolean {
    var drm: MediaDrm? = null
    var sessionId: ByteArray? = null
    return try {
      // Level 1: constructor
      drm = MediaDrm(C.WIDEVINE_UUID)
      // Level 2: openSession — forces real HAL session creation
      sessionId = drm.openSession()
      // Level 3: HAL property IPC
      drm.getPropertyString("securityLevel")
      android.util.Log.d("IcareOfflineDrm", "isWidevineAvailable: all checks passed")
      true
    } catch (e: Throwable) {
      android.util.Log.d("IcareOfflineDrm", "isWidevineAvailable: FAILED — ${e::class.simpleName}: ${e.message}")
      false
    } finally {
      try { sessionId?.let { drm?.closeSession(it) } } catch (_: Throwable) {}
      try { @Suppress("DEPRECATION") drm?.release() } catch (_: Throwable) {}
    }
  }

  /**
   * Attempts to provision this device's Widevine DRM certificate by sending a
   * provisioning request to Google's certificate server.
   *
   * Background: [isWidevineAvailable] can fail with ERROR_DRM_NOT_PROVISIONED on
   * devices (commonly MIUI/Xiaomi) whose Widevine HAL is present but whose keybox
   * certificate was never installed. The Android MediaDrm API provides a standard
   * provisioning mechanism — the same one Google Play Services uses at first boot —
   * that we can invoke on demand from within the app.
   *
   * Flow:
   *  1. Create MediaDrm and call [MediaDrm.getProvisionRequest] to obtain a signed
   *     certificate request.
   *  2. POST the signed request to Google's provisioning server (defaultUrl).
   *  3. Feed the server's response back via [MediaDrm.provideProvisionResponse],
   *     which installs the keybox onto the device.
   *  4. Return true if all steps succeed; false otherwise.
   *
   * After a successful call, [isWidevineAvailable] should return true.
   */
  fun provisionDevice(): Boolean {
    var drm: MediaDrm? = null
    return try {
      drm = MediaDrm(C.WIDEVINE_UUID)
      val provRequest = drm.getProvisionRequest()
      // Google's provisioning server expects the signed request appended to the URL.
      // provRequest.data is already Base64URL-encoded; converting to UTF-8 is correct.
      val provUrl = "${provRequest.defaultUrl}&signedRequest=${String(provRequest.data, Charsets.UTF_8)}"
      android.util.Log.d("IcareOfflineDrm", "provisionDevice: contacting ${provRequest.defaultUrl}")

      val conn = java.net.URL(provUrl).openConnection() as java.net.HttpURLConnection
      conn.apply {
        requestMethod = "POST"
        doOutput = false
        connectTimeout = 15_000
        readTimeout = 15_000
      }
      conn.connect()

      val responseCode = conn.responseCode
      if (responseCode !in 200..299) {
        android.util.Log.e("IcareOfflineDrm", "provisionDevice: server returned HTTP $responseCode")
        return false
      }
      val responseBytes = conn.inputStream.use { it.readBytes() }
      conn.disconnect()

      drm.provideProvisionResponse(responseBytes)
      android.util.Log.d("IcareOfflineDrm", "provisionDevice: SUCCESS — device is now provisioned")
      true
    } catch (e: Throwable) {
      android.util.Log.e("IcareOfflineDrm", "provisionDevice: FAILED — ${e::class.simpleName}: ${e.message}")
      false
    } finally {
      try { @Suppress("DEPRECATION") drm?.release() } catch (_: Throwable) {}
    }
  }

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
    if (!latch.await(8, java.util.concurrent.TimeUnit.SECONDS))
      throw java.io.IOException("DownloadHelper prep timed out (8 s) — DRM or network unavailable")
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
