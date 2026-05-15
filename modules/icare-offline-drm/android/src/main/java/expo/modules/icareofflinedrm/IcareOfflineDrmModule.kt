package expo.modules.icareofflinedrm

import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadCursor
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.DownloadService
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.Serializable

class StartDownloadParamsRecord : Record, Serializable {
  @Field var id: String = ""
  @Field var manifestUrl: String = ""
  @Field var drmLicenseUrl: String = ""
  @Field var drmToken: String = ""
  @Field var title: String? = null
}

class PlaybackSourceParamsRecord : Record, Serializable {
  @Field var id: String = ""
}

@UnstableApi
class IcareOfflineDrmModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("IcareOfflineDrm")

    Events("onDownloadProgress")

    OnCreate {
      // Wire the singleton emitter so the DownloadService can push events back.
      DownloadEventBridge.emitter = { info ->
        sendEvent("onDownloadProgress", info)
      }
    }

    OnDestroy {
      DownloadEventBridge.emitter = null
    }

    AsyncFunction("startDownload") { params: StartDownloadParamsRecord, promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)

        // 1) Acquire the offline Widevine license + persist its keySetId.
        OfflineLicenseManager.acquireAndStore(
          ctx,
          downloadId = params.id,
          manifestUrl = params.manifestUrl,
          licenseUrl = params.drmLicenseUrl,
          licenseToken = params.drmToken,
        )

        // 2) Build the download request (HLS by default — Mux returns m3u8).
        val helper = DownloadUtil.getDownloadHelper(
          ctx,
          mediaItemId = params.id,
          uri = Uri.parse(params.manifestUrl),
        )
        val downloadRequest: DownloadRequest = helper
          .prepareAsBlocking()
          .getDownloadRequest(params.id, null)
        helper.release()

        // 3) Hand off to the DownloadService.
        DownloadService.sendAddDownload(
          ctx,
          OfflineDownloadService::class.java,
          downloadRequest,
          /* foreground = */ true,
        )

        promise.resolve(null)
      } catch (e: Throwable) {
        promise.reject("EDOWNLOAD_START_FAILED", e.message ?: "Unknown error", e)
      }
    }

    AsyncFunction("pauseDownload") { id: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction
      DownloadService.sendSetStopReason(
        ctx,
        OfflineDownloadService::class.java,
        id,
        /* stopReason = */ 1,
        /* foreground = */ false,
      )
    }

    AsyncFunction("resumeDownload") { id: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction
      DownloadService.sendSetStopReason(
        ctx,
        OfflineDownloadService::class.java,
        id,
        /* stopReason = */ Download.STOP_REASON_NONE,
        /* foreground = */ false,
      )
    }

    AsyncFunction("removeDownload") { id: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction
      DownloadService.sendRemoveDownload(
        ctx,
        OfflineDownloadService::class.java,
        id,
        /* foreground = */ false,
      )
      OfflineLicenseManager.release(ctx, id)
    }

    AsyncFunction("listDownloads") { promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        val out = mutableListOf<Map<String, Any?>>()
        val cursor: DownloadCursor =
          DownloadUtil.getDownloadManager(ctx).downloadIndex.getDownloads()
        cursor.use {
          while (cursor.moveToNext()) {
            out.add(toMap(cursor.download))
          }
        }
        promise.resolve(out)
      } catch (e: Throwable) {
        promise.reject("ELIST_FAILED", e.message ?: "Unknown error", e)
      }
    }

    AsyncFunction("getDownload") { id: String, promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        val d = DownloadUtil.getDownloadManager(ctx).downloadIndex.getDownload(id)
        promise.resolve(d?.let { toMap(it) })
      } catch (e: Throwable) {
        promise.reject("EGET_FAILED", e.message ?: "Unknown error", e)
      }
    }

    AsyncFunction("getOfflineSource") { params: PlaybackSourceParamsRecord, promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        val download = DownloadUtil.getDownloadManager(ctx)
          .downloadIndex.getDownload(params.id)
        if (download == null || download.state != Download.STATE_COMPLETED) {
          promise.resolve(null)
          return@AsyncFunction
        }
        val keySetIdB64 = OfflineLicenseManager.getKeySetIdB64(ctx, params.id)
        if (keySetIdB64 == null) {
          // No persisted offline license — caller should renew or re-download.
          promise.resolve(null)
          return@AsyncFunction
        }
        val out = mapOf(
          "cacheKey" to params.id,
          "uri" to download.request.uri.toString(),
          "offlineLicenseKeySetId" to keySetIdB64,
        )
        promise.resolve(out)
      } catch (e: Throwable) {
        promise.reject("EOFFLINE_SOURCE_FAILED", e.message ?: "Unknown error", e)
      }
    }

    AsyncFunction("renewOfflineLicense") {
      id: String, drmLicenseUrl: String, drmToken: String, promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        val download = DownloadUtil.getDownloadManager(ctx)
          .downloadIndex.getDownload(id)
          ?: throw CodedException("ENO_DOWNLOAD", "No download for id=$id", null)
        OfflineLicenseManager.acquireAndStore(
          ctx,
          downloadId = id,
          manifestUrl = download.request.uri.toString(),
          licenseUrl = drmLicenseUrl,
          licenseToken = drmToken,
        )
        promise.resolve(null)
      } catch (e: Throwable) {
        promise.reject("ERENEW_FAILED", e.message ?: "Unknown error", e)
      }
    }
  }

  private fun toMap(d: Download): Map<String, Any?> {
    val state = when (d.state) {
      Download.STATE_QUEUED -> "queued"
      Download.STATE_DOWNLOADING -> "downloading"
      Download.STATE_COMPLETED -> "completed"
      Download.STATE_FAILED -> "failed"
      Download.STATE_REMOVING -> "removing"
      Download.STATE_RESTARTING -> "restarting"
      Download.STATE_STOPPED -> "stopped"
      else -> "queued"
    }
    val pct = if (d.percentDownloaded.isNaN()) -1.0 else d.percentDownloaded.toDouble()
    return mapOf(
      "id" to d.request.id,
      "state" to state,
      "bytesDownloaded" to d.bytesDownloaded.toDouble(),
      "contentLength" to d.contentLength.toDouble(),
      "percentDownloaded" to pct,
      "failureReason" to d.failureReason.takeIf { d.state == Download.STATE_FAILED }?.toString(),
    )
  }
}
