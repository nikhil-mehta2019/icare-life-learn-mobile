package expo.modules.icareofflinedrm

import android.app.Activity
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.drm.LocalMediaDrmCallback
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView

private const val TAG = "OfflinePlayerActivity"

/**
 * Full-screen offline DRM player Activity.
 *
 * Launched by IcareOfflineDrmModule.launchOfflinePlayer(id).
 * Uses the persisted Widevine keySetId for offline DRM playback via
 * DefaultDrmSessionManager.Builder().setKeySetId() — the official
 * Media3 offline license restore path.
 *
 * Data source: CacheDataSource.Factory wrapping DownloadUtil.getDownloadCache()
 * so all segment reads come from the local cache, zero network calls needed.
 */
@UnstableApi
class OfflinePlayerActivity : Activity() {

    companion object {
        const val EXTRA_DOWNLOAD_ID = "download_id"
        const val EXTRA_TITLE       = "chapter_title"
    }

    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep screen on, full-screen immersive
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        val downloadId = intent.getStringExtra(EXTRA_DOWNLOAD_ID) ?: run {
            Log.e(TAG, "No download_id in intent")
            finish()
            return
        }
        val title = intent.getStringExtra(EXTRA_TITLE) ?: downloadId

        // ── Layout (pure code, no XML resource needed) ──────────────────────
        val root = FrameLayout(this)
        root.setBackgroundColor(0xFF000000.toInt())

        val pv = PlayerView(this)
        pv.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        )
        pv.useController = true
        pv.setShowSubtitleButton(true)
        playerView = pv
        root.addView(pv)

        // Title overlay at top-left (visible while controls are shown)
        val titleView = TextView(this)
        titleView.text = title
        titleView.setTextColor(0xFFFFFFFF.toInt())
        titleView.textSize = 14f
        titleView.setPadding(32, 32, 32, 0)
        titleView.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
        )
        root.addView(titleView)

        // Close button (top-right)
        val closeBtn = ImageButton(this)
        closeBtn.setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
        closeBtn.setBackgroundColor(0x66000000.toInt())
        val closeLp = FrameLayout.LayoutParams(96, 96)
        closeLp.gravity = android.view.Gravity.TOP or android.view.Gravity.END
        closeLp.topMargin = 24
        closeLp.rightMargin = 24
        closeBtn.layoutParams = closeLp
        closeBtn.setOnClickListener { finish() }
        root.addView(closeBtn)

        setContentView(root)

        // ── Resolve the download from DownloadManager ────────────────────────
        val download = try {
            DownloadUtil.getDownloadManager(applicationContext)
                .downloadIndex.getDownload(downloadId)
        } catch (e: Throwable) {
            Log.e(TAG, "getDownload failed: ${e.message}", e)
            null
        }

        if (download == null) {
            Log.e(TAG, "No download found for id=$downloadId")
            titleView.text = "Download not found: $title"
            return
        }

        val manifestUri = download.request.uri
        Log.d(TAG, "starting offline playback: id=$downloadId uri=$manifestUri")

        // ── Load persisted keySetId ──────────────────────────────────────────
        val keySetIdB64 = OfflineLicenseManager.getKeySetIdB64(applicationContext, downloadId)
        val keySetId: ByteArray? = keySetIdB64?.let {
            try { Base64.decode(it, Base64.NO_WRAP) }
            catch (e: Throwable) {
                Log.e(TAG, "keySetId decode failed: ${e.message}")
                null
            }
        }
        Log.d(TAG, "keySetId present=${keySetId != null} length=${keySetId?.size ?: 0}")

        // ── Build DRM session manager ────────────────────────────────────────
        // If we have a keySetId, use the offline restore path.
        // If no keySetId (signed-only, non-DRM content), no DRM manager needed.
        val drmSessionManager: DefaultDrmSessionManager? = if (keySetId != null) {
            try {
                DefaultDrmSessionManager.Builder()
                    .setUuidAndExoMediaDrmProvider(
                        C.WIDEVINE_UUID,
                        FrameworkMediaDrm.DEFAULT_PROVIDER,
                    )
                    .setMultiSession(false)
                    .build(
                        // Offline restore: no network calls — keySetId is the sole source
                        androidx.media3.exoplayer.drm.LocalMediaDrmCallback(ByteArray(0))
                    )
                    .also { it.setMode(DefaultDrmSessionManager.MODE_PLAYBACK, keySetId) }
            } catch (e: Throwable) {
                Log.e(TAG, "DRM manager build failed: ${e.message}", e)
                null
            }
        } else {
            Log.d(TAG, "no keySetId — playing as clear/signed content")
            null
        }

        // ── Build data source: reads entirely from local cache ───────────────
        val cacheDataSourceFactory = CacheDataSource.Factory()
            .setCache(DownloadUtil.getDownloadCache(applicationContext))
            .setFlags(CacheDataSource.FLAG_BLOCK_ON_CACHE)

        // ── Build media source ───────────────────────────────────────────────
        val drmManagerProvider: DrmSessionManagerProvider? =
            if (drmSessionManager != null) DrmSessionManagerProvider { drmSessionManager }
            else null

        val hlsFactory = HlsMediaSource.Factory(cacheDataSourceFactory)
            .also { factory ->
                if (drmManagerProvider != null) {
                    factory.setDrmSessionManagerProvider(drmManagerProvider)
                }
            }

        val mediaItem = MediaItem.Builder()
            .setMediaId(downloadId)
            .setUri(manifestUri)
            .setMimeType(MimeTypes.APPLICATION_M3U8)
            .build()

        val mediaSource = hlsFactory.createMediaSource(mediaItem)

        // ── Build ExoPlayer ──────────────────────────────────────────────────
        // Configure a DefaultTrackSelector so that:
        //   • Text/subtitle tracks with no declared language are still selected
        //     (setSelectUndeterminedTextLanguage) — fixes missing captions.
        //   • Adaptive audio groups are presented as a single "Auto" entry in the
        //     track-selector UI — reduces the duplicate-track clutter seen when
        //     multiple bitrate variants of the same language are in the manifest.
        val trackSelector = androidx.media3.exoplayer.trackselection.DefaultTrackSelector(this).apply {
            setParameters(
                buildUponParameters()
                    .setSelectUndeterminedTextLanguage(true)
                    .setAllowMultipleAdaptiveSelections(false)
                    .build()
            )
        }
        val exo = ExoPlayer.Builder(this)
            .setTrackSelector(trackSelector)
            .build()
        player = exo
        pv.player = exo

        exo.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG,
                    "playback error: code=${error.errorCode} msg=${error.message}",
                    error)
                titleView.text = "Playback error (${error.errorCode}): ${error.message}"
            }
            override fun onPlaybackStateChanged(state: Int) {
                Log.d(TAG, "playbackState=${
                    when (state) {
                        Player.STATE_IDLE -> "IDLE"
                        Player.STATE_BUFFERING -> "BUFFERING"
                        Player.STATE_READY -> "READY"
                        Player.STATE_ENDED -> "ENDED"
                        else -> state.toString()
                    }
                }")
            }
        })

        exo.setMediaSource(mediaSource)
        exo.prepare()
        exo.playWhenReady = true
    }

    override fun onStart() {
        super.onStart()
        player?.play()
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        super.onDestroy()
        playerView?.player = null
        player?.release()
        player = null
    }
}
