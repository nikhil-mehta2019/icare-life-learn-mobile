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
import java.util.Locale

private const val TAG = "OfflinePlayerActivity"

@UnstableApi
class OfflinePlayerActivity : Activity() {

    companion object {
        const val EXTRA_DOWNLOAD_ID = "download_id"
        const val EXTRA_TITLE       = "chapter_title"
    }

    private data class TrackChoice(
        val key: String,
        val label: String,
        val group: androidx.media3.common.TrackGroup,
        val trackIndex: Int,
        val bitrate: Int,
    )

    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var audioButton: TextView? = null
    private var captionButton: TextView? = null
    private var audioChoices: List<TrackChoice> = emptyList()
    private var captionChoices: List<TrackChoice> = emptyList()
    private var preferredCodes: List<String> = emptyList()
    private var initialPreferencesApplied = false
    private var selectedAudioKey: String? = null
    private var selectedCaptionKey: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        preferredCodes = LanguagePreferenceStore.get(applicationContext)
        Log.d(TAG, "ordered learner language preferences=$preferredCodes")

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
        pv.setShowSubtitleButton(false)
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
        // Keep the exit affordance out of the immersive/cinema-mode edge area.
        // This is deliberately 50 px lower than the previous 24 px position.
        closeLp.topMargin = 74
        closeLp.rightMargin = 24
        closeBtn.layoutParams = closeLp
        closeBtn.contentDescription = "Close offline player"
        closeBtn.setOnClickListener { finish() }
        root.addView(closeBtn)

        // Single-line landscape chips avoid the clipped two-line treatment while
        // keeping control identity and active language visible at all times.
        val audioBtn = makeTopControl("AUDIO", "Audio", 136, 250)
        audioBtn.setOnClickListener { showAudioChooser() }
        audioButton = audioBtn
        root.addView(audioBtn)

        val captionsBtn = makeTopControl("CC", "CC", 402, 250)
        captionsBtn.setOnClickListener { showCaptionChooser() }
        captionButton = captionsBtn
        root.addView(captionsBtn)

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

            override fun onTracksChanged(tracks: Tracks) {
                rebuildChoices(tracks)
                applyInitialLanguagePreferences()
            }
        })

        exo.setMediaSource(mediaSource)
        exo.prepare()
        exo.playWhenReady = true
    }

    private fun makeTopControl(
        label: String,
        value: String,
        rightMargin: Int,
        width: Int,
    ): TextView {
        return TextView(this).apply {
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 13f
            gravity = Gravity.CENTER
            maxLines = 1
            setPadding(18, 0, 18, 0)
            setBackgroundColor(0xB3000000.toInt())
            visibility = View.GONE
            setControlText(this, label, value)
            layoutParams = FrameLayout.LayoutParams(width, 64).also {
                it.gravity = Gravity.TOP or Gravity.END
                it.topMargin = 30
                it.rightMargin = rightMargin
            }
        }
    }

    private fun setControlText(button: TextView, label: String, value: String) {
        val visibleValue = shortLabel(value)
        button.text = "$label · $visibleValue  ▾"
        button.contentDescription = "$label, $value. Double tap to change."
    }

    private fun rebuildChoices(tracks: Tracks) {
        val audioByLanguage = linkedMapOf<String, TrackChoice>()
        val captionsByLanguage = linkedMapOf<String, TrackChoice>()

        for (group in tracks.groups) {
            if (group.length == 0) continue
            for (trackIndex in 0 until group.length) {
                if (!group.isTrackSupported(trackIndex)) continue
                val fmt = group.getTrackFormat(trackIndex)
                val languageKey = LanguagePreferenceStore.normalizeCode(fmt.language ?: fmt.label)
                if (languageKey.isBlank()) continue
                val candidate = TrackChoice(
                    key = languageKey,
                    label = languageDisplayName(languageKey, fmt.label),
                    group = group.mediaTrackGroup,
                    trackIndex = trackIndex,
                    bitrate = if (fmt.bitrate > 0) fmt.bitrate else 0,
                )

                when (group.type) {
                    C.TRACK_TYPE_AUDIO -> {
                        val current = audioByLanguage[languageKey]
                        if (current == null || candidate.bitrate > current.bitrate) audioByLanguage[languageKey] = candidate
                    }
                    C.TRACK_TYPE_TEXT -> if (!captionsByLanguage.containsKey(languageKey)) captionsByLanguage[languageKey] = candidate
                }
            }
        }

        audioChoices = orderAndFilter(audioByLanguage)
        captionChoices = orderAndFilter(captionsByLanguage)
        audioButton?.visibility = if (audioChoices.isNotEmpty()) View.VISIBLE else View.GONE
        captionButton?.visibility = if (captionChoices.isNotEmpty()) View.VISIBLE else View.GONE

        Log.d(TAG, "allowed audio choices=${audioChoices.joinToString { "${it.label}[${it.key}]" }}")
        Log.d(TAG, "allowed caption choices=${captionChoices.joinToString { "${it.label}[${it.key}]" }}")
    }

    private fun orderAndFilter(byLanguage: LinkedHashMap<String, TrackChoice>): List<TrackChoice> {
        if (preferredCodes.isEmpty()) return byLanguage.values.toList()
        return preferredCodes.mapNotNull { byLanguage[it] }
    }

    private fun applyInitialLanguagePreferences() {
        if (initialPreferencesApplied) return
        val currentPlayer = player ?: return
        if (audioChoices.isEmpty() && captionChoices.isEmpty()) return

        val builder = currentPlayer.trackSelectionParameters.buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
            .clearOverridesOfType(C.TRACK_TYPE_TEXT)

        audioChoices.firstOrNull()?.let { choice ->
            builder.addOverride(TrackSelectionOverride(choice.group, listOf(choice.trackIndex)))
            selectedAudioKey = choice.key
            audioButton?.let { setControlText(it, "AUDIO", choice.label) }
            Log.d(TAG, "initial audio=${choice.label} key=${choice.key}")
        }

        val initialCaption = captionChoices.firstOrNull()
        if (initialCaption != null) {
            builder
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .addOverride(TrackSelectionOverride(initialCaption.group, listOf(initialCaption.trackIndex)))
            selectedCaptionKey = initialCaption.key
            captionButton?.let { setControlText(it, "CC", initialCaption.label) }
            Log.d(TAG, "initial captions=${initialCaption.label} key=${initialCaption.key}")
        } else {
            builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            selectedCaptionKey = null
            captionButton?.let { setControlText(it, "CC", "Off") }
            Log.d(TAG, "initial captions=OFF — no preferred caption available")
        }

        currentPlayer.trackSelectionParameters = builder.build()
        initialPreferencesApplied = true
    }

    private fun languageDisplayName(code: String, label: String?): String {
        val display = try {
            val locale = Locale.forLanguageTag(code)
            locale.getDisplayLanguage(Locale.ENGLISH).takeIf { it.isNotBlank() && it != code }
        } catch (_: Throwable) { null }
        return display ?: label?.trim().takeUnless { it.isNullOrBlank() } ?: code.uppercase(Locale.ROOT)
    }

    private fun shortLabel(label: String): String = label.take(16)

    private fun showAudioChooser() {
        val choices = audioChoices
        if (choices.isEmpty()) return
        val labels = choices.map { it.label }.toTypedArray()
        val checkedIndex = choices.indexOfFirst { it.key == selectedAudioKey }.coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle("Audio track")
            .setSingleChoiceItems(labels, checkedIndex) { dialog, which ->
                val currentPlayer = player ?: return@setSingleChoiceItems
                val choice = choices[which]
                val builder = currentPlayer.trackSelectionParameters.buildUpon()
                    .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                    .addOverride(TrackSelectionOverride(choice.group, listOf(choice.trackIndex)))
                currentPlayer.trackSelectionParameters = builder.build()
                selectedAudioKey = choice.key
                audioButton?.let { setControlText(it, "AUDIO", choice.label) }
                Log.d(TAG, "audio selected=${choice.label} key=${choice.key} bitrate=${choice.bitrate}")
                dialog.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showCaptionChooser() {
        val choices = captionChoices
        if (choices.isEmpty()) return
        val labels = arrayOf("Off", *choices.map { it.label }.toTypedArray())
        val selectedIndex = selectedCaptionKey?.let { key -> choices.indexOfFirst { it.key == key }.takeIf { it >= 0 }?.plus(1) } ?: 0
        AlertDialog.Builder(this)
            .setTitle("Subtitles (CC)")
            .setSingleChoiceItems(labels, selectedIndex) { dialog, which ->
                val currentPlayer = player ?: return@setSingleChoiceItems
                val builder = currentPlayer.trackSelectionParameters.buildUpon()
                    .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                if (which == 0) {
                    builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    selectedCaptionKey = null
                    captionButton?.let { setControlText(it, "CC", "Off") }
                    Log.d(TAG, "captions selected=OFF")
                } else {
                    val choice = choices[which - 1]
                    builder
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                        .addOverride(TrackSelectionOverride(choice.group, listOf(choice.trackIndex)))
                    selectedCaptionKey = choice.key
                    captionButton?.let { setControlText(it, "CC", choice.label) }
                    Log.d(TAG, "captions selected=${choice.label} key=${choice.key}")
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
        captionChoices = emptyList()
        selectedAudioKey = null
        selectedCaptionKey = null
        audioButton = null
        captionButton = null
    }
}
