package expo.modules.icareofflinedrm

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.RendererCapabilitiesList
import androidx.media3.exoplayer.offline.DefaultDownloadIndex
import androidx.media3.exoplayer.offline.DefaultDownloaderFactory
import androidx.media3.exoplayer.offline.DownloadHelper
import androidx.media3.exoplayer.offline.DownloadManager
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "IcareOfflineDrm"
private const val USER_AGENT = "IcareLifeLearn-Android-Offline/1.0"

@UnstableApi
object DownloadUtil {
  private const val DOWNLOAD_CONTENT_DIRECTORY = "icare-downloads"

  private var downloadCache: SimpleCache? = null
  private var downloadManager: DownloadManager? = null
  private var databaseProvider: StandaloneDatabaseProvider? = null

  @Synchronized
  fun getDownloadCache(ctx: Context): SimpleCache {
    val existing = downloadCache
    if (existing != null) return existing
    val dir = File(ctx.filesDir, DOWNLOAD_CONTENT_DIRECTORY)
    dir.mkdirs()
    File(dir, ".nomedia").let { if (!it.exists()) it.createNewFile() }
    val cache = SimpleCache(dir, NoOpCacheEvictor(), getDatabaseProvider(ctx))
    downloadCache = cache
    return cache
  }

  @Synchronized
  fun getDownloadManager(ctx: Context): DownloadManager {
    val existing = downloadManager
    if (existing != null) return existing

    val okClient = OkHttpClient.Builder()
      .readTimeout(15, TimeUnit.SECONDS)
      // ManifestBufferingInterceptor is innermost (added last): buffers chunked HLS
      // manifests into a fixed-length body so OkHttpDataSource gets an immediate EOF.
      // DiagnosticInterceptor is outermost: logs first playlist and first segment status.
      .addInterceptor(DiagnosticInterceptor())
      .addInterceptor(ManifestBufferingInterceptor())
      .build()

    val httpFactory = OkHttpDataSource.Factory(okClient).setUserAgent(USER_AGENT)

    val cacheFactory = CacheDataSource.Factory()
      .setCache(getDownloadCache(ctx))
      .setUpstreamDataSourceFactory(httpFactory)

    val mgr = DownloadManager(
      ctx,
      DefaultDownloadIndex(getDatabaseProvider(ctx)),
      DefaultDownloaderFactory(cacheFactory, Executors.newFixedThreadPool(3)),
    )
    mgr.maxParallelDownloads = 2
    downloadManager = mgr
    return mgr
  }

  @Synchronized
  fun getDatabaseProvider(ctx: Context): StandaloneDatabaseProvider {
    val existing = databaseProvider
    if (existing != null) return existing
    val provider = StandaloneDatabaseProvider(ctx)
    databaseProvider = provider
    return provider
  }

  fun getDownloadHelperForMediaItem(ctx: Context, mediaItem: MediaItem): DownloadHelper {
    return DownloadHelper(
      mediaItem,
      null,
      DownloadHelper.DEFAULT_TRACK_SELECTOR_PARAMETERS_WITHOUT_CONTEXT,
      object : RendererCapabilitiesList {
        private val empty = emptyArray<RendererCapabilities>()
        override fun getRendererCapabilities(): Array<RendererCapabilities> = empty
        override fun size(): Int = 0
        override fun release() {}
      }
    )
  }
}

private class DiagnosticInterceptor : Interceptor {
  companion object {
    val playlistLogged = AtomicBoolean(false)
    val segmentLogged  = AtomicBoolean(false)
  }

  override fun intercept(chain: Interceptor.Chain): Response {
    val url = chain.request().url.toString()
    val isSegment  = url.contains(".m4s") || url.contains(".ts") ||
                     url.contains(".aac") || (url.contains(".mp4") && !url.contains("manifest"))
    val isPlaylist = !isSegment && (url.contains(".m3u8") || url.contains("manifest") ||
                     url.contains("playlist", ignoreCase = true))

    val response = chain.proceed(chain.request())

    if (isPlaylist && playlistLogged.compareAndSet(false, true)) {
      android.util.Log.d(TAG, "[DL] playlist status=${response.code} url=${url.take(120)}")
    } else if (isSegment && segmentLogged.compareAndSet(false, true)) {
      android.util.Log.d(TAG, "[DL] first-segment status=${response.code} url=${url.take(120)}")
    }

    return response
  }
}

private class ManifestBufferingInterceptor : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val response = chain.proceed(chain.request())
    val ct  = response.header("Content-Type") ?: ""
    val url = chain.request().url.toString()
    val isManifest = ct.contains("mpegurl", ignoreCase = true) ||
                     ct.contains("m3u8",    ignoreCase = true) ||
                     url.contains(".m3u8",  ignoreCase = true) ||
                     (url.contains("manifest", ignoreCase = true) && !url.contains(".m4s") && !url.contains(".ts"))
    if (!isManifest) return response
    val body = response.body ?: return response
    return try {
      val bytes = body.bytes()
      val mediaType = ct.ifEmpty { "application/x-mpegURL" }.toMediaType()
      response.newBuilder().body(bytes.toResponseBody(mediaType)).build()
    } catch (_: Throwable) {
      response
    }
  }
}
