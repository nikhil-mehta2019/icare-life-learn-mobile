package expo.modules.icareofflinedrm

import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackSelectionOverride
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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class StartDownloadParamsRecord : Record, Serializable {
  @Field var id: String = ""
  @Field var manifestUrl: String = ""
  @Field var drmLicenseUrl: String = ""
  @Field var drmToken: String = ""
  @Field var title: String? = null
  @Field var thumbnailUrl: String? = null
  @Field var durationSeconds: Int? = null
  /** Audio language codes to download (e.g. ["en", "es"]). Null/empty = all languages. */
  @Field var audioLanguages: List<String>? = null
  /** Caption/subtitle language codes to download. Null/empty = all languages. */
  @Field var captionLanguages: List<String>? = null
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

        // 1) Persist metadata so the downloads list can show it without a network call.
        if (!params.title.isNullOrBlank()) {
          DownloadMetadata.saveTitle(ctx, params.id, params.title!!)
        }
        if (!params.thumbnailUrl.isNullOrBlank()) {
          DownloadMetadata.saveThumbnailUrl(ctx, params.id, params.thumbnailUrl!!)
        }
        params.durationSeconds?.let { dur ->
          if (dur > 0) DownloadMetadata.saveDuration(ctx, params.id, dur)
        }

        // 2) Acquire the offline Widevine license + persist its keySetId.
        //    ONLY for DRM-protected content (drmLicenseUrl is non-empty).
        //    Signed-only (non-DRM) chapters have an empty drmLicenseUrl and
        //    no PSSH in the manifest. Calling acquireAndStore() for those
        //    triggers ExoPlayer's DRM init path, which hangs for 30 s and
        //    throws "DownloadHelper prep timed out".
        val isDrmProtected = !params.drmLicenseUrl.isNullOrEmpty()
        var widevineOk = OfflineLicenseManager.isWidevineAvailable()
        var manifestHasDrm = false
        if (isDrmProtected) {
          if (!widevineOk) {
            val provisioned = OfflineLicenseManager.provisionDevice()
            if (provisioned) widevineOk = OfflineLicenseManager.isWidevineAvailable()
          }
          if (!widevineOk) {
            throw IllegalStateException("Widevine DRM is not available on this device")
          }
          manifestHasDrm = OfflineLicenseManager.acquireAndStore(
            ctx,
            downloadId = params.id,
            manifestUrl = params.manifestUrl,
            licenseUrl = params.drmLicenseUrl,
            licenseToken = params.drmToken,
          )
        }

        val mediaItemForHelper = if (manifestHasDrm) {
          val drmCfg = MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID)
            .setLicenseUri(params.drmLicenseUrl)
            .apply {
              if (!params.drmToken.isNullOrEmpty()) {
                setLicenseRequestHeaders(mapOf("x-mux-license-token" to params.drmToken))
              }
            }
            .build()
          MediaItem.Builder()
            .setMediaId(params.id)
            .setUri(Uri.parse(params.manifestUrl))
            .setMimeType("application/x-mpegURL")
            .setDrmConfiguration(drmCfg)
            .build()
        } else {
          MediaItem.Builder()
            .setMediaId(params.id)
            .setUri(Uri.parse(params.manifestUrl))
            .setMimeType("application/x-mpegURL")
            .build()
        }
        val latch = java.util.concurrent.CountDownLatch(1)
        val prepErr = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val downloadRequestRef = java.util.concurrent.atomic.AtomicReference<DownloadRequest?>()
        val helperRef = java.util.concurrent.atomic.AtomicReference<androidx.media3.exoplayer.offline.DownloadHelper?>()
        android.os.Handler(android.os.Looper.getMainLooper()).post {
          try {
            val helper = DownloadUtil.getDownloadHelperForMediaItem(ctx, mediaItemForHelper)
            helperRef.set(helper)
            helper.prepare(object : androidx.media3.exoplayer.offline.DownloadHelper.Callback {
              override fun onPrepared(h: androidx.media3.exoplayer.offline.DownloadHelper, isEmpty: Boolean) {
                val TAG = "IcareOfflineDrm"
                try {
                  val defaultParams = androidx.media3.exoplayer.offline.DownloadHelper
                    .getDefaultTrackSelectorParameters(ctx)

                  // Empty/null set = no filtering (download all languages).
                  val audioLangFilter = params.audioLanguages?.filter { it.isNotBlank() }?.toSet() ?: emptySet()
                  val captionLangFilter = params.captionLanguages?.filter { it.isNotBlank() }?.toSet() ?: emptySet()
                  Log.d(TAG,
                    "=== onPrepared START === periodCount=${h.periodCount} " +
                    "audioLangFilter=$audioLangFilter captionLangFilter=$captionLangFilter")

                  // Global counters across all periods/renderers — the required
                  // "Total audio groups discovered / selected" summary.
                  var totalAudioGroupsDiscovered = 0
                  var totalAudioGroupsSelected = 0
                  val allSelectedAudioLangs = mutableListOf<String>()
                  // Track every (lang) we've already selected ACROSS periods+renderers,
                  // so if the same logical rendition is exposed more than once — whether
                  // via multiple periods, multiple renderers, or multiple TrackGroups in
                  // the same period — we only ever addTrackSelection() for it once.
                  val globallySelectedAudioLangs = mutableSetOf<String>()

                  for (periodIndex in 0 until h.periodCount) {
                    h.clearTrackSelections(periodIndex)

                    val mappedTrackInfo = h.getMappedTrackInfo(periodIndex)
                    val rendererCount = mappedTrackInfo.rendererCount
                    Log.d(TAG, "--- period=$periodIndex rendererCount=$rendererCount ---")

                    // ── Discover every audio TrackGroup across every renderer in this
                    // period. Media3's DownloadHelper can map audio to more than one
                    // renderer index (e.g. if the manifest declares groups that get
                    // assigned to distinct renderers), so iterating h.getTrackGroups()
                    // (a flattened, period-level view) alone can miss the renderer
                    // dimension. We log both to prove/disprove exactly where
                    // duplication is introduced.
                    data class AudioGroupInfo(
                      val rendererIndex: Int,
                      val groupIndexInRenderer: Int,
                      val group: androidx.media3.common.TrackGroup,
                      val format: androidx.media3.common.Format,
                    )
                    val discovered = mutableListOf<AudioGroupInfo>()

                    for (rendererIndex in 0 until rendererCount) {
                      if (mappedTrackInfo.getRendererType(rendererIndex) != C.TRACK_TYPE_AUDIO) continue
                      val groups = mappedTrackInfo.getTrackGroups(rendererIndex)
                      for (gi in 0 until groups.length) {
                        val g = groups.get(gi)
                        if (g.length == 0) continue
                        val fmt = g.getFormat(0)
                        val groupHash = System.identityHashCode(g)
                        Log.d(TAG,
                          "AUDIO_GROUP_DISCOVERED renderer=$rendererIndex period=$periodIndex " +
                          "groupIndex=$gi groupHash=$groupHash lang=${fmt.language} label=${fmt.label} " +
                          "roleFlags=${fmt.roleFlags} mime=${fmt.sampleMimeType} codecs=${fmt.codecs} " +
                          "channelCount=${fmt.channelCount} bitrate=${fmt.bitrate} trackCount=${g.length} " +
                          "formatId=${fmt.id}")
                        discovered.add(AudioGroupInfo(rendererIndex, gi, g, fmt))
                      }
                    }
                    totalAudioGroupsDiscovered += discovered.size

                    // Detect whether "duplicates" are truly distinct TrackGroup
                    // objects (different identity hash) or the same manifest data
                    // being iterated more than once.
                    val byLang = discovered.groupBy { it.format.language ?: "und" }
                    for ((lang, groupsForLang) in byLang) {
                      if (groupsForLang.size <= 1) continue
                      val hashes = groupsForLang.map { System.identityHashCode(it.group) }
                      val renderers = groupsForLang.map { it.rendererIndex }.distinct()
                      val bitrates = groupsForLang.map { it.format.bitrate }
                      val formatIds = groupsForLang.map { it.format.id }
                      Log.w(TAG,
                        "DUPLICATE_LANG_DETECTED lang=$lang count=${groupsForLang.size} " +
                        "distinctRenderers=$renderers distinctGroupHashes=${hashes.distinct()} " +
                        "bitrates=$bitrates formatIds=$formatIds " +
                        "sameGroupObject=${hashes.distinct().size == 1} " +
                        "sameRenderer=${renderers.size == 1}")
                    }

                    // ── Select ONE group per language — highest bitrate wins.
                    // Dedup key is language only (matches product requirement: one
                    // menu entry per language), and — critically — the "already
                    // selected" check is GLOBAL (globallySelectedAudioLangs), not
                    // scoped to this renderer or this period, so no downstream loop
                    // can re-select a language we already picked.
                    val bestPerLang = mutableMapOf<String, AudioGroupInfo>()
                    for (info in discovered) {
                      val lang = info.format.language ?: "und"
                      if (audioLangFilter.isNotEmpty() && lang !in audioLangFilter) continue
                      val bits = if (info.format.bitrate > 0) info.format.bitrate else Int.MAX_VALUE
                      val cur = bestPerLang[lang]
                      if (cur == null || bits >= (if (cur.format.bitrate > 0) cur.format.bitrate else Int.MAX_VALUE)) {
                        bestPerLang[lang] = info
                      }
                    }

                    // 1. Video — let defaultParams pick the adaptive quality set
                    h.addTrackSelection(
                      periodIndex,
                      defaultParams.buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT,  true)
                        .build()
                    )

                    // 2. Audio — ONE group per language, globally deduped.
                    for ((lang, info) in bestPerLang) {
                      if (lang in globallySelectedAudioLangs) {
                        Log.w(TAG,
                          "AUDIO_GROUP_SKIPPED_ALREADY_SELECTED renderer=${info.rendererIndex} " +
                          "period=$periodIndex groupIndex=${info.groupIndexInRenderer} lang=$lang " +
                          "reason='language already selected in a prior period/renderer'")
                        continue
                      }
                      Log.d(TAG,
                        "AUDIO_GROUP_SELECTED renderer=${info.rendererIndex} period=$periodIndex " +
                        "groupIndex=${info.groupIndexInRenderer} lang=$lang bitrate=${info.format.bitrate} " +
                        "formatId=${info.format.id} reason='highest bitrate for this language, not yet downloaded'")
                      h.addTrackSelection(
                        periodIndex,
                        defaultParams.buildUpon()
                          .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
                          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT,  true)
                          .addOverride(TrackSelectionOverride(info.group, (0 until info.group.length).toList()))
                          .build()
                      )
                      globallySelectedAudioLangs.add(lang)
                      totalAudioGroupsSelected++
                      allSelectedAudioLangs.add(lang)
                    }

                    // 3. Text/subtitle — include declared groups, filtered by captionLangFilter
                    //    (empty filter = all languages, preserving prior behavior).
                    //    Use the period-level flattened view here since captions were
                    //    never the source of the audio-duplication bug and this keeps
                    //    the fix minimal/scoped.
                    val tga = h.getTrackGroups(periodIndex)
                    for (i in 0 until tga.length) {
                      val g = tga.get(i)
                      if (g.length == 0) continue
                      if (!MimeTypes.isText(g.getFormat(0).sampleMimeType ?: "")) continue
                      val lang = g.getFormat(0).language ?: "und"
                      if (captionLangFilter.isNotEmpty() && lang !in captionLangFilter) continue
                      h.addTrackSelection(
                        periodIndex,
                        defaultParams.buildUpon()
                          .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
                          .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
                          .addOverride(TrackSelectionOverride(g, (0 until g.length).toList()))
                          .build()
                      )
                    }
                  }

                  Log.d(TAG,
                    "=== onPrepared SUMMARY === totalAudioGroupsDiscovered=$totalAudioGroupsDiscovered " +
                    "totalAudioGroupsSelected=$totalAudioGroupsSelected languagesSelected=$allSelectedAudioLangs")

                  downloadRequestRef.set(h.getDownloadRequest(params.id, null))
                }
                catch (e: Throwable) {
                  Log.e(TAG, "onPrepared track-selection failed", e)
                  prepErr.set(e)
                }
                latch.countDown()
              }
              override fun onPrepareError(h: androidx.media3.exoplayer.offline.DownloadHelper, e: java.io.IOException) {
                android.util.Log.e("IcareOfflineDrm", "onPrepareError", e)
                prepErr.set(e); latch.countDown()
              }
            })
          } catch (e: Throwable) {
            android.util.Log.e("IcareOfflineDrm", "DownloadHelper.prepare threw", e)
            prepErr.set(e); latch.countDown()
          }
        }
        if (!latch.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
          throw java.io.IOException("DownloadHelper prep timed out")
        }
        android.os.Handler(android.os.Looper.getMainLooper()).post {
          helperRef.getAndSet(null)?.release()
        }
        prepErr.get()?.let { throw it }
        val downloadRequest: DownloadRequest = downloadRequestRef.get()
          ?: throw java.io.IOException("DownloadHelper produced no DownloadRequest")

        DownloadEventBridge.reset()
        DownloadService.sendAddDownload(
          ctx,
          OfflineDownloadService::class.java,
          downloadRequest,
          /* foreground = */ true,
        )

        promise.resolve(null)
      } catch (e: Throwable) {
        android.util.Log.e("IcareOfflineDrm", "startDownload failed", e)
        promise.reject("EDOWNLOAD_START_FAILED", e.message ?: e.toString(), e)
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
      DownloadMetadata.removeTitle(ctx, id)
      DownloadMetadata.removeCompletedAt(ctx, id)
      DownloadMetadata.removeThumbnailUrl(ctx, id)
      DownloadMetadata.removeDuration(ctx, id)
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
            out.add(toMap(ctx, cursor.download))
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
        promise.resolve(d?.let { toMap(ctx, it) })
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
        // keySetId is null for signed-only (non-DRM) downloads — that's fine,
        // the player uses the cached segments without a Widevine license.
        val keySetIdB64 = OfflineLicenseManager.getKeySetIdB64(ctx, params.id)
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

    AsyncFunction("getDownloadsDebug") { promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        val mgr = DownloadUtil.getDownloadManager(ctx)
        android.util.Log.d("IcareOfflineDrm",
          "[DOWNLOAD-SERVICE] getDownloadsDebug dmIdentity=${System.identityHashCode(mgr)}")
        val out = mutableListOf<Map<String, Any?>>()
        val cursor: DownloadCursor = mgr.downloadIndex.getDownloads()
        cursor.use {
          while (cursor.moveToNext()) {
            val d = cursor.download
            val stateStr = when (d.state) {
              Download.STATE_QUEUED      -> "QUEUED"
              Download.STATE_DOWNLOADING -> "DOWNLOADING"
              Download.STATE_COMPLETED   -> "COMPLETED"
              Download.STATE_FAILED      -> "FAILED"
              Download.STATE_REMOVING    -> "REMOVING"
              Download.STATE_RESTARTING  -> "RESTARTING"
              Download.STATE_STOPPED     -> "STOPPED"
              else                       -> "UNKNOWN(${d.state})"
            }
            val pct = if (d.percentDownloaded.isNaN()) -1.0 else d.percentDownloaded.toDouble()
            val entry = mapOf(
              "downloadId"        to d.request.id,
              "state"             to stateStr,
              "bytesDownloaded"   to d.bytesDownloaded.toDouble(),
              "contentLength"     to d.contentLength.toDouble(),
              "percentDownloaded" to pct,
            )
            android.util.Log.d("IcareOfflineDrm",
              "[DOWNLOAD-SERVICE] getDownloadsDebug: id=${d.request.id} state=$stateStr" +
              " bytes=${d.bytesDownloaded} contentLength=${d.contentLength}" +
              " pct=${"%.1f".format(pct)}")
            out.add(entry)
          }
        }
        android.util.Log.d("IcareOfflineDrm",
          "[DOWNLOAD-SERVICE] getDownloadsDebug: downloadCount=${out.size}")
        promise.resolve(mapOf("downloadCount" to out.size, "downloads" to out))
      } catch (e: Throwable) {
        promise.reject("EDEBUG_FAILED", e.message ?: "Unknown error", e)
      }
    }

    AsyncFunction("launchOfflinePlayer") { id: String, promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        val download = DownloadUtil.getDownloadManager(ctx).downloadIndex.getDownload(id)
        if (download == null || download.state != androidx.media3.exoplayer.offline.Download.STATE_COMPLETED) {
          throw CodedException("ENO_DOWNLOAD", "No completed download for id=$id", null)
        }
        val title = DownloadMetadata.getTitle(ctx, id) ?: id
        // Launch from the current Activity (not FLAG_ACTIVITY_NEW_TASK) so
        // OfflinePlayerActivity joins the app's existing task/back-stack.
        // A separate task previously let the player keep playing in the
        // background after in-app navigation, since it never received a
        // reliable onStop() as part of the RN app's own navigation.
        val activityCtx = appContext.currentActivity
          ?: throw CodedException("ENO_ACTIVITY", "No current Activity to launch from", null)
        val intent = android.content.Intent(activityCtx, OfflinePlayerActivity::class.java).apply {
          putExtra(OfflinePlayerActivity.EXTRA_DOWNLOAD_ID, id)
          putExtra(OfflinePlayerActivity.EXTRA_TITLE, title)
        }
        activityCtx.startActivity(intent)
        promise.resolve(null)
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Throwable) {
        promise.reject("ELAUNCH_FAILED", e.message ?: "Unknown error", e)
      }
    }

    AsyncFunction("getStorageStats") { promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        var totalBytes = 0L
        var completedCount = 0
        val cursor: DownloadCursor =
          DownloadUtil.getDownloadManager(ctx).downloadIndex.getDownloads()
        cursor.use {
          while (cursor.moveToNext()) {
            val d = cursor.download
            totalBytes += d.bytesDownloaded
            if (d.state == Download.STATE_COMPLETED) completedCount++
          }
        }
        promise.resolve(mapOf(
          "usedBytes" to totalBytes.toDouble(),
          "downloadCount" to completedCount,
        ))
      } catch (e: Throwable) {
        promise.reject("ESTATS_FAILED", e.message ?: "Unknown error", e)
      }
    }
  }

  private fun toMap(ctx: android.content.Context, d: Download): Map<String, Any?> {
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

    // Record completion timestamp the first time state transitions to completed.
    if (d.state == Download.STATE_COMPLETED) {
      DownloadMetadata.ensureCompletedAt(ctx, d.request.id)
    }

    return mapOf(
      "id" to d.request.id,
      "state" to state,
      "bytesDownloaded" to d.bytesDownloaded.toDouble(),
      "contentLength" to d.contentLength.toDouble(),
      "percentDownloaded" to pct,
      "failureReason" to d.failureReason.takeIf { d.state == Download.STATE_FAILED }?.toString(),
      "title" to DownloadMetadata.getTitle(ctx, d.request.id),
      "downloadedAt" to DownloadMetadata.getCompletedAt(ctx, d.request.id),
      "thumbnailUrl" to DownloadMetadata.getThumbnailUrl(ctx, d.request.id),
      "durationSeconds" to DownloadMetadata.getDuration(ctx, d.request.id),
    )
  }
}
