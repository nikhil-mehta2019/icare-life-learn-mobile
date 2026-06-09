package expo.modules.icareofflinedrm

import android.content.Context
import android.media.MediaDrm
import android.util.Base64
import androidx.media3.common.C
import androidx.media3.common.DrmInitData
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.DrmSessionEventListener
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback
import androidx.media3.exoplayer.drm.OfflineLicenseHelper
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

  /**
   * Fetches the manifest, checks for a real Widevine PSSH, acquires an offline
   * license if found, and returns true. Returns false if the manifest has no
   * Widevine encryption (signed-only stream) — caller should then build the
   * DownloadHelper MediaItem without DRM config.
   */
  fun acquireAndStore(
    ctx: Context,
    downloadId: String,
    manifestUrl: String,
    licenseUrl: String,
    licenseToken: String,
  ): Boolean {
    if (!isWidevineAvailable()) {
      throw IllegalStateException(
        "Widevine DRM is not available on this device — offline download of DRM-protected content is not supported"
      )
    }

    android.util.Log.d("IcareOfflineDrm", "fetchPsshFromManifest:\nmanifestUrl=$manifestUrl")
    val psshBytes = fetchPsshFromManifest(manifestUrl)
    if (psshBytes == null) {
      android.util.Log.w("IcareOfflineDrm", "no Widevine SESSION-KEY found")
      return false
    }
    android.util.Log.d("IcareOfflineDrm", "found Widevine SESSION-KEY")

    val drmInitData = DrmInitData(
      DrmInitData.SchemeData(C.WIDEVINE_UUID, MimeTypes.VIDEO_MP4, psshBytes)
    )
    val format = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_H264)
      .setDrmInitData(drmInitData)
      .build()

    android.util.Log.d("IcareOfflineDrm",
      "acquireLicense: psshBytes=${psshBytes.size}B licenseUrl=$licenseUrl drmTokenPresent=${licenseToken.isNotEmpty()}")
    val offlineHelper = newOfflineHelper(licenseUrl, licenseToken)
    android.util.Log.d("IcareOfflineDrm", "acquireLicense: calling downloadLicense() …")
    val keySetId = try {
      val ks = offlineHelper.downloadLicense(format)
      android.util.Log.d("IcareOfflineDrm", "offline license acquired — keySetId ${ks.size} bytes")
      ks
    } catch (e: Throwable) {
      android.util.Log.e("IcareOfflineDrm",
        "offline license acquisition FAILED — ${e::class.simpleName}: ${e.message}", e)
      throw e
    } finally {
      try { offlineHelper.release() } catch (_: Throwable) {}
    }

    android.util.Log.d("IcareOfflineDrm", "acquireLicense: persisting keySetId for downloadId=$downloadId")
    prefs(ctx).edit()
      .putString(KEY_PREFIX + downloadId, Base64.encodeToString(keySetId, Base64.NO_WRAP))
      .apply()
    android.util.Log.d("IcareOfflineDrm", "acquireLicense: keySetId persisted — acquireAndStore returning true")
    return true
  }

  private fun fetchUrl(url: String): Pair<Int, String?> {
    val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
    conn.connectTimeout = 15_000
    conn.readTimeout    = 15_000
    conn.setRequestProperty("User-Agent", "IcareLifeLearn/1.0")
    conn.connect()
    val code = conn.responseCode
    val body = if (code in 200..299) conn.inputStream.bufferedReader().readText() else null
    conn.disconnect()
    return Pair(code, body)
  }

  private fun logDrmLines(tag: String, label: String, body: String) {
    val keywords = listOf("EXT-X-SESSION-KEY", "EXT-X-KEY", "KEYFORMAT", "URI=", "edef8ba9", "widevine")
    val lines = body.lines()
    val matches = lines.filter { line -> keywords.any { line.contains(it, ignoreCase = true) } }
    if (matches.isEmpty()) {
      android.util.Log.w(tag, "$label: no DRM-related lines found")
    } else {
      android.util.Log.d(tag, "$label: ${matches.size} DRM-related line(s):\n${matches.joinToString("\n")}")
    }
  }

  private fun extractPssh(body: String): ByteArray? {
    val TAG = "IcareOfflineDrm"

    // Primary: scan the entire body for a data-URI PSSH — no line splitting,
    // no UUID search, no tag matching. This token is unique to DRM PSSH payloads
    // in HLS and cannot appear elsewhere in a valid manifest.
    val dataUriMatch = Regex(
      """data:text/plain[^,]*,([A-Za-z0-9+/=]+)""",
      RegexOption.IGNORE_CASE
    ).find(body)

    if (dataUriMatch != null) {
      val b64 = dataUriMatch.groupValues[1]
      android.util.Log.d(TAG, "extractPssh: regex match found")
      android.util.Log.d(TAG, "extractPssh: base64 length=${b64.length}")
      return try {
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        android.util.Log.d(TAG, "extractPssh: decoded PSSH bytes=${bytes.size}")
        bytes
      } catch (e: Throwable) {
        android.util.Log.e(TAG, "extractPssh: Base64 decode failed — ${e.message}")
        null
      }
    }

    // Fallback: UUID present but no data-URI (e.g. bare base64 or external key URL).
    // Find the nearest URI="..." value after the Widevine UUID.
    val widevineUuid = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
    val uuidIdx = body.indexOf(widevineUuid, ignoreCase = true)
    if (uuidIdx >= 0) {
      val uriMatch = Regex("""URI="([^"]+)"""").find(body)
      if (uriMatch != null) {
        val uriVal = uriMatch.groupValues[1]
        val b64 = if (uriVal.startsWith("data:")) uriVal.substringAfter("base64,") else uriVal
        android.util.Log.d(TAG, "extractPssh: fallback URI match, base64 length=${b64.length}")
        return try {
          val bytes = Base64.decode(b64, Base64.DEFAULT)
          android.util.Log.d(TAG, "extractPssh: decoded PSSH bytes=${bytes.size}")
          bytes
        } catch (e: Throwable) {
          android.util.Log.e(TAG, "extractPssh: fallback Base64 decode failed — ${e.message}")
          null
        }
      }
    }

    android.util.Log.w(TAG, "extractPssh: no PSSH found in body (length=${body.length})")
    return null
  }

  /**
   * Fetches the HLS master manifest, dumps it fully for diagnosis, follows every
   * variant playlist URL, and searches all of them for a Widevine PSSH.
   *
   * Mux may place the EXT-X-SESSION-KEY in the master playlist OR the media playlist.
   * This function checks both levels exhaustively and logs everything it finds.
   */
  private fun fetchPsshFromManifest(manifestUrl: String): ByteArray? {
    val TAG = "IcareOfflineDrm"
    try {
      // ── 1. Fetch master playlist ─────────────────────────────────────────────
      android.util.Log.d(TAG, "fetchPsshFromManifest: fetching master → $manifestUrl")
      val (masterCode, masterBody) = fetchUrl(manifestUrl)
      android.util.Log.d(TAG, "fetchPsshFromManifest: master HTTP $masterCode")
      if (masterCode !in 200..299 || masterBody == null) {
        android.util.Log.e(TAG, "fetchPsshFromManifest: master fetch failed — HTTP $masterCode")
        return null
      }

      // ── 2. Dump full master playlist ─────────────────────────────────────────
      // Logcat truncates at ~4 KB; chunk into 3000-char blocks so nothing is lost.
      val masterLines = masterBody.lines()
      android.util.Log.d(TAG, "fetchPsshFromManifest: master playlist — ${masterLines.size} lines, ${masterBody.length} chars")
      masterBody.chunked(3000).forEachIndexed { i, chunk ->
        android.util.Log.d(TAG, "MASTER[$i]:\n$chunk")
      }

      // ── 3. Log DRM-related lines in master ───────────────────────────────────
      logDrmLines(TAG, "master", masterBody)

      // ── 4. Try to extract PSSH directly from master ──────────────────────────
      val masterPssh = extractPssh(masterBody)
      if (masterPssh != null) {
        android.util.Log.d(TAG, "fetchPsshFromManifest: PSSH found in master playlist")
        return masterPssh
      }
      android.util.Log.d(TAG, "fetchPsshFromManifest: no PSSH in master — will inspect variant playlists")

      // ── 5. Collect variant playlist URLs from master ─────────────────────────
      // A master playlist line is a variant URL if it follows an #EXT-X-STREAM-INF
      // tag or if it ends with .m3u8 (some Mux manifests omit the tag on the URL line).
      val variantUrls = mutableListOf<String>()
      var nextIsVariant = false
      val baseUrl = manifestUrl.substringBeforeLast('/')
      for (line in masterLines) {
        val trimmed = line.trim()
        if (trimmed.startsWith("#EXT-X-STREAM-INF") || trimmed.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
          nextIsVariant = true
          continue
        }
        if (nextIsVariant && trimmed.isNotEmpty() && !trimmed.startsWith('#')) {
          val url = if (trimmed.startsWith("http")) trimmed else "$baseUrl/$trimmed"
          variantUrls.add(url)
          nextIsVariant = false
          continue
        }
        if (!trimmed.startsWith('#') && trimmed.endsWith(".m3u8")) {
          val url = if (trimmed.startsWith("http")) trimmed else "$baseUrl/$trimmed"
          if (url !in variantUrls) variantUrls.add(url)
        }
        nextIsVariant = false
      }
      android.util.Log.d(TAG, "fetchPsshFromManifest: found ${variantUrls.size} variant playlist URL(s)")
      variantUrls.forEachIndexed { i, u -> android.util.Log.d(TAG, "  variant[$i]: $u") }

      // ── 6. Fetch each variant playlist and search for PSSH ───────────────────
      for ((idx, variantUrl) in variantUrls.withIndex()) {
        try {
          android.util.Log.d(TAG, "fetchPsshFromManifest: fetching variant[$idx] → $variantUrl")
          val (vCode, vBody) = fetchUrl(variantUrl)
          android.util.Log.d(TAG, "fetchPsshFromManifest: variant[$idx] HTTP $vCode")
          if (vCode !in 200..299 || vBody == null) {
            android.util.Log.w(TAG, "fetchPsshFromManifest: variant[$idx] fetch failed — skipping")
            continue
          }
          val vLines = vBody.lines()
          android.util.Log.d(TAG, "fetchPsshFromManifest: variant[$idx] — ${vLines.size} lines, ${vBody.length} chars")
          // Dump full variant for diagnosis
          vBody.chunked(3000).forEachIndexed { i, chunk ->
            android.util.Log.d(TAG, "VARIANT[$idx][$i]:\n$chunk")
          }
          logDrmLines(TAG, "variant[$idx]", vBody)
          val pssh = extractPssh(vBody)
          if (pssh != null) {
            android.util.Log.d(TAG, "fetchPsshFromManifest: PSSH found in variant[$idx]")
            return pssh
          }
        } catch (e: Throwable) {
          android.util.Log.w(TAG, "fetchPsshFromManifest: variant[$idx] exception — ${e::class.simpleName}: ${e.message}")
        }
      }

      android.util.Log.w(TAG, "fetchPsshFromManifest: no PSSH found in master or any variant playlist")
      return null
    } catch (e: Throwable) {
      android.util.Log.e("IcareOfflineDrm", "fetchPsshFromManifest: exception — ${e::class.simpleName}: ${e.message}")
      return null
    }
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

}
