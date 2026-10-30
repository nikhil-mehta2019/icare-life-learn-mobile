package expo.modules.icareofflinedrm

import android.app.Notification
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Requirements
import androidx.media3.exoplayer.scheduler.Scheduler

private const val FOREGROUND_NOTIFICATION_ID = 9201
private const val NOTIF_CHANNEL_ID = "icare_downloads"

@UnstableApi
class OfflineDownloadService : DownloadService(
  FOREGROUND_NOTIFICATION_ID,
  DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL,
  NOTIF_CHANNEL_ID,
  android.R.string.dialog_alert_title,
  0,
) {

  override fun getDownloadManager(): DownloadManager {
    val mgr = DownloadUtil.getDownloadManager(this)

    mgr.addListener(object : DownloadManager.Listener {
      private val mainHandler = Handler(Looper.getMainLooper())
      private var progressPoller: Runnable? = null

      private fun startProgressPoller(downloadManager: DownloadManager) {
        if (progressPoller != null) return
        val poller = object : Runnable {
          override fun run() {
            val active = downloadManager.currentDownloads
            if (active.isEmpty()) { progressPoller = null; return }
            for (d in active) {
              if (d.state == Download.STATE_DOWNLOADING) {
                DownloadEventBridge.emit(d)
              }
            }
            mainHandler.postDelayed(this, 2_000L)
          }
        }
        progressPoller = poller
        mainHandler.postDelayed(poller, 2_000L)
      }

      override fun onDownloadChanged(
        downloadManager: DownloadManager,
        download: Download,
        finalException: Exception?,
      ) {
        when (download.state) {
          Download.STATE_DOWNLOADING -> {
            android.util.Log.d("IcareOfflineDrm", "[DL] state=DOWNLOADING id=${download.request.id}")
            startProgressPoller(downloadManager)
          }
          Download.STATE_FAILED -> {
            android.util.Log.e("IcareOfflineDrm",
              "[DL] FAILED id=${download.request.id} reason=${download.failureReason}" +
              if (finalException != null) " exception=${finalException::class.simpleName}: ${finalException.message}" else "")
          }
          Download.STATE_COMPLETED -> {
            android.util.Log.d("IcareOfflineDrm", "[DL] state=COMPLETED id=${download.request.id}")
          }
          else -> {}
        }
        DownloadEventBridge.emit(download)
      }

      override fun onDownloadRemoved(mgr: DownloadManager, download: Download) {}
      override fun onIdle(mgr: DownloadManager) {}
      override fun onRequirementsStateChanged(mgr: DownloadManager, requirements: Requirements, notMetRequirements: Int) {}
    })
    return mgr
  }

  override fun getScheduler(): Scheduler? = null

  override fun getForegroundNotification(
    downloads: MutableList<Download>,
    notMetRequirements: Int,
  ): Notification {
    val active = downloads.count { it.state == Download.STATE_DOWNLOADING }
    return androidx.core.app.NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("Downloading lessons")
      .setContentText("$active active · ${downloads.size} total")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
  }
}
