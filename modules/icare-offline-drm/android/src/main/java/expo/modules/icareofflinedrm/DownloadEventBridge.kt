package expo.modules.icareofflinedrm

import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download

/**
 * Static glue between OfflineDownloadService (Android-managed lifecycle) and
 * IcareOfflineDrmModule (Expo-managed lifecycle, can be re-created when JS
 * reloads). The module sets the emitter; the service calls it.
 */
@UnstableApi
object DownloadEventBridge {
  @Volatile
  var emitter: ((Map<String, Any?>) -> Unit)? = null

  fun emit(download: Download) {
    val payload = mapOf(
      "id" to download.request.id,
      "state" to stateName(download.state),
      "bytesDownloaded" to download.bytesDownloaded.toDouble(),
      "contentLength" to download.contentLength.toDouble(),
      "percentDownloaded" to if (download.percentDownloaded.isNaN()) -1.0 else download.percentDownloaded.toDouble(),
      "failureReason" to download.failureReason.takeIf { download.state == Download.STATE_FAILED }?.toString(),
    )
    emitter?.invoke(payload)
  }

  private fun stateName(s: Int) = when (s) {
    Download.STATE_QUEUED -> "queued"
    Download.STATE_DOWNLOADING -> "downloading"
    Download.STATE_COMPLETED -> "completed"
    Download.STATE_FAILED -> "failed"
    Download.STATE_REMOVING -> "removing"
    Download.STATE_RESTARTING -> "restarting"
    Download.STATE_STOPPED -> "stopped"
    else -> "queued"
  }
}
