package expo.modules.icareofflinedrm

import android.app.Notification
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
  /* channelNameResourceId = */ android.R.string.dialog_alert_title,
  /* channelDescriptionResourceId = */ 0,
) {

  override fun getDownloadManager(): DownloadManager {
    val mgr = DownloadUtil.getDownloadManager(this)
    // Forward state changes to the JS event bridge.
    mgr.addListener(object : DownloadManager.Listener {
      override fun onDownloadChanged(
        downloadManager: DownloadManager,
        download: Download,
        finalException: Exception?,
      ) {
        DownloadEventBridge.emit(download)
      }
    })
    return mgr
  }

  override fun getScheduler(): Scheduler? = null

  override fun getForegroundNotification(
    downloads: MutableList<Download>,
    notMetRequirements: Int,
  ): Notification {
    // Minimal notification — apps that need styled progress can extend this.
    val builder = androidx.core.app.NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("Downloading lessons")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
    val total = downloads.size
    val active = downloads.count { it.state == Download.STATE_DOWNLOADING }
    builder.setContentText("$active active · $total total")
    return builder.build()
  }
}
