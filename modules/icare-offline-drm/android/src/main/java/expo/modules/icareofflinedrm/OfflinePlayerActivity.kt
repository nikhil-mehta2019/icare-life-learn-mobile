package expo.modules.icareofflinedrm

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.Gravity
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
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView

private const val TAG = "OfflinePlayerActivity"

@UnstableApi
class OfflinePlayerActivity : Activity() {

    companion object {
        const val EXTRA_DOWNLOAD_ID = "download_id"
        const val EXTRA_TITLE       = "chapter_title"
    }

    private data class AudioChoice(
        val key: String,
        val label: String,
        val group: androidx.media3.common.TrackGroup,
        val trackIndex: Int,
        val bitrate: Int,
    )

    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var audioButton: TextView? = null
    private var audioChoices: List<AudioChoice> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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

        pv.post {
            pv.findViewById<View>(androidx.media3.ui.R.id.exo_settings)?.visibility = View.GONE
        }

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

        val closeBtn = ImageButton(this)
        closeBtn.setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
        closeBtn.setBackgroundColor(0x66000000.toInt())
        val closeLp = FrameLayout.LayoutParams(96, 96)
        closeLp.gravity = Gravity.TOP or Gravity.END
        closeLp.topMargin = 24
        closeLp.rightMargin = 24
        closeBtn.layoutParams = closeLp
        closeBtn.setOnClickListener { finish() }
        root.addView(closeBtn)

        val audioBtn = TextView(this)
        audioBtn.text = "Audio"
        audioBtn.setTextColor(0xFFFFFFFF.toInt())
        audioBtn.textSize = 14f
        audioBtn.gravity = Gravity.CENTER
        audioBtn.setPadding(24, 0, 24, 0)
        audioBtn.setBackgroundColor(0x66000000.toInt())
        audioBtn.visibility = View.GONE
        val audioLp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, 80)
        audioLp.gravity = Gravity.TOP or Gravity.END
        audioLp.topMargin = 32
        audioLp.rightMargin = 140
        audioBtn.layoutParams = audioLp
        audioBtn.setOnClickListener { showAudioChooser() }
        audioButton = audioBtn
        root.addView(audioBtn)

        setContentView(root)

        val download = try {
            DownloadUtil.getDownloadManager(applicationContext).downloadIndex.getDownload(downloadId)
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

        val keySetIdB64 = OfflineLicenseManager.getKeySetIdB64(applicationContext, downloadId)
        val keySetId: ByteArray? = keySetIdB64?.let {
            try { Base64.decode(it, Base64.NO_WRAP) }
            catch (e: Throwable) { Log.e(TAG, "keySetId decode failed: ${e.message}"); null }
        }
        Log.d(TAG, "keySetId present=${keySetId != null} length=${keySetId?.size ?: 0}")

        val drmSessionManager: DefaultDrmSessionManager? = if (keySetId != null) {
            try {
                DefaultDrmSessionManager.Builder()
                    .setUuidAndExoMediaDrmProvider(C.WIDEVINE_UUID, FrameworkMediaDrm.DEFAULT_PROVIDER)
                    .setMultiSession(false)
                    .build(androidx.media3.exoplayer.drm.LocalMediaDrmCallback(ByteArray(0)))
                    .also { it.setMode(DefaultDrmSessionManager.MODE_PLAYBACK, keySetId) }
            } catch (e: Throwable) {
                Log.e(TAG, "DRM manager build failed: ${e.message}", e)
                null
            }
        } else {
            Log.d(TAG, "no keySetId — playing as clear/signed content")
            null
        }

        val cacheDataSourceFactory = CacheDataSource.Factory()
            .setCache(DownloadUtil.getDownloadCache(applicationContext))
            .setFlags(CacheDataSource.FLAG_BLOCK_ON_CACHE)

        val drmManagerProvider: DrmSessionManagerProvider? =
            if (drmSessionManager != null) DrmSessionManagerProvider { drmSessionManager } else null

        val hlsFactory = HlsMediaSource.Factory(cacheDataSourceFactory).also { factory ->
            if (drmManagerProvider != null) factory.setDrmSessionManagerProvider(drmManagerProvider)
        }

        val mediaItem = MediaItem.Builder()
            .setMediaId(downloadId)
            .setUri(manifestUri)
            .setMimeType(MimeTypes.APPLICATION_M3U8)
            .build()
        val mediaSource = hlsFactory.createMediaSource(mediaItem)

        val trackSelector = androidx.media3.exoplayer.trackselection.DefaultTrackSelector(this).apply {
            setParameters(
                buildUponParameters()
                    .setSelectUndeterminedTextLanguage(true)
                    .setAllowMultipleAdaptiveSelections(false)
                    .build()
            )
        }
        val exo = ExoPlayer.Builder(this).setTrackSelector(trackSelector).build()
        player = exo
        pv.player = exo

        exo.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "playback error: code=${error.errorCode} msg=${error.message}", error)
                titleView.text = "Playback error (${error.errorCode}): ${error.message}"
            }
            override fun onPlaybackStateChanged(state: Int) {
                Log.d(TAG, "playbackState=${when (state) {
                    Player.STATE_IDLE -> "IDLE"
                    Player.STATE_BUFFERING -> "BUFFERING"
                    Player.STATE_READY -> "READY"
                    Player.STATE_ENDED -> "ENDED"
                    else -> state.toString()
                }}")
            }
            override fun onTracksChanged(tracks: Tracks) { rebuildAudioChoices(tracks) }
        })

        exo.setMediaSource(mediaSource)
        exo.prepare()
        exo.playWhenReady = true
    }

    private fun rebuildAudioChoices(tracks: Tracks) {
        val bestByLanguage = linkedMapOf<String, AudioChoice>()
        for (group in tracks.groups) {
            if (group.type != C.TRACK_TYPE_AUDIO || group.length == 0) continue
            for (trackIndex in 0 until group.length) {
                if (!group.isTrackSupported(trackIndex)) continue
                val fmt = group.getTrackFormat(trackIndex)
                val rawLanguage = fmt.language?.trim()?.lowercase()
                val languageKey = when {
                    !rawLanguage.isNullOrBlank() -> rawLanguage.substringBefore('-').substringBefore('_')
                    !fmt.label.isNullOrBlank() -> fmt.label!!.trim().lowercase()
                    else -> "audio"
                }
                val candidate = AudioChoice(
                    key = languageKey,
                    label = languageDisplayName(rawLanguage, fmt.label),
                    group = group.mediaTrackGroup,
                    trackIndex = trackIndex,
                    bitrate = if (fmt.bitrate > 0) fmt.bitrate else 0,
                )
                val current = bestByLanguage[languageKey]
                if (current == null || candidate.bitrate > current.bitrate) bestByLanguage[languageKey] = candidate
            }
        }
        audioChoices = bestByLanguage.values.toList()
        audioButton?.visibility = if (audioChoices.size > 1) View.VISIBLE else View.GONE
        Log.d(TAG, "dedup audio choices=${audioChoices.joinToString { "${it.label}[${it.key}]@${it.bitrate}" }}")
    }

    private fun languageDisplayName(language: String?, label: String?): String {
        val base = language?.lowercase()?.substringBefore('-')?.substringBefore('_')
        return when (base) {
            "en", "eng" -> "English Stereo"
            "es", "spa" -> "Spanish Stereo"
            "sw", "swa" -> "Swahili Stereo"
            "hi", "hin" -> "Hindi Stereo"
            "mr", "mar" -> "Marathi Stereo"
            "gu", "guj" -> "Gujarati Stereo"
            else -> label?.trim().takeUnless { it.isNullOrBlank() } ?: "Audio"
        }
    }

    private fun showAudioChooser() {
        val choices = audioChoices
        if (choices.isEmpty()) return
        val labels = arrayOf("Auto", *choices.map { it.label }.toTypedArray())
        AlertDialog.Builder(this)
            .setTitle("Audio")
            .setSingleChoiceItems(labels, -1) { dialog, which ->
                val currentPlayer = player ?: return@setSingleChoiceItems
                val builder = currentPlayer.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                if (which > 0) {
                    val choice = choices[which - 1]
                    builder.addOverride(TrackSelectionOverride(choice.group, listOf(choice.trackIndex)))
                    audioButton?.text = choice.label.substringBefore(" Stereo")
                    Log.d(TAG, "audio selected=${choice.label} key=${choice.key} bitrate=${choice.bitrate}")
                } else {
                    audioButton?.text = "Audio"
                    Log.d(TAG, "audio selected=Auto")
                }
                currentPlayer.trackSelectionParameters = builder.build()
                dialog.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onStart() { super.onStart(); player?.play() }
    override fun onStop() { super.onStop(); player?.pause() }
    override fun onDestroy() {
        super.onDestroy()
        playerView?.player = null
        player?.release()
        player = null
        audioChoices = emptyList()
        audioButton = null
    }
}
