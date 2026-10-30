package expo.modules.icareofflinedrm

import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download

@UnstableApi
object DownloadEventBridge {
  @Volatile
  var emitter: ((Map<String, Any?>) -> Unit)? = null

  private var firstProgressLogged = false

  fun emit(download: Download) {
    val pct = if (download.percentDownloaded.isNaN()) -1.0 else download.percentDownloaded.toDouble()
    if (download.state == Download.STATE_DOWNLOADING && download.bytesDownloaded > 0L && !firstProgressLogged) {
      firstProgressLogged = true
      android.util.Log.d("IcareOfflineDrm",
        "[DL] progress bytes=${download.bytesDownloaded} pct=${"%.1f".format(pct)}")
    }
    val e = emitter ?: return
    e.invoke(mapOf(
      "id" to download.request.id,
      "state" to stateName(download.state),
      "bytesDownloaded" to download.bytesDownloaded.toDouble(),
      "contentLength" to download.contentLength.toDouble(),
      "percentDownloaded" to pct,
      "failureReason" to download.failureReason.takeIf { download.state == Download.STATE_FAILED }?.toString(),
    ))
  }

  fun reset() { firstProgressLogged = false }

  private fun stateName(s: Int) = when (s) {
    Download.STATE_QUEUED      -> "queued"
    Download.STATE_DOWNLOADING -> "downloading"
    Download.STATE_COMPLETED   -> "completed"
    Download.STATE_FAILED      -> "failed"
    Download.STATE_REMOVING    -> "removing"
    Download.STATE_RESTARTING  -> "restarting"
    Download.STATE_STOPPED     -> "stopped"
    else                       -> "queued"
  }
}
