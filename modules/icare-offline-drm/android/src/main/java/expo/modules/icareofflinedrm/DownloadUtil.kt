package expo.modules.icareofflinedrm

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.offline.DefaultDownloadIndex
import androidx.media3.exoplayer.offline.DefaultDownloaderFactory
import androidx.media3.exoplayer.offline.DownloadHelper
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.datasource.cache.CacheDataSource
import java.io.File
import java.util.concurrent.Executors

@UnstableApi
object DownloadUtil {
  private const val DOWNLOAD_CONTENT_DIRECTORY = "icare-downloads"
  private const val USER_AGENT = "IcareLifeLearn-Android-Offline/1.0"

  private var downloadCache: SimpleCache? = null
  private var downloadManager: DownloadManager? = null
  private var databaseProvider: StandaloneDatabaseProvider? = null

  @Synchronized
  fun getDownloadCache(ctx: Context): SimpleCache {
    val existing = downloadCache
    if (existing != null) return existing
    val dir = File(ctx.filesDir, DOWNLOAD_CONTENT_DIRECTORY)
    val cache = SimpleCache(dir, NoOpCacheEvictor(), getDatabaseProvider(ctx))
    downloadCache = cache
    return cache
  }

  @Synchronized
  fun getDownloadManager(ctx: Context): DownloadManager {
    val existing = downloadManager
    if (existing != null) return existing
    val dbProvider = getDatabaseProvider(ctx)
    val cache = getDownloadCache(ctx)
    val httpFactory = DefaultHttpDataSource.Factory().setUserAgent(USER_AGENT)
    val downloaderFactory = DefaultDownloaderFactory(
      CacheDataSource.Factory()
        .setCache(cache)
        .setUpstreamDataSourceFactory(httpFactory),
      Executors.newFixedThreadPool(3),
    )
    val mgr = DownloadManager(
      ctx,
      DefaultDownloadIndex(dbProvider),
      downloaderFactory,
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

  fun getDownloadHelper(ctx: Context, mediaItemId: String, uri: Uri): DownloadHelper {
    val mediaItem = MediaItem.Builder().setMediaId(mediaItemId).setUri(uri).build()
    val httpFactory = DefaultHttpDataSource.Factory().setUserAgent(USER_AGENT)
    return DownloadHelper.forMediaItem(
      ctx,
      mediaItem,
      DefaultRenderersFactory(ctx),
      httpFactory,
    )
  }

  /** Convenience: synchronous prepare for short manifests. */
  fun DownloadHelper.prepareAsBlocking(): DownloadHelper {
    val latch = java.util.concurrent.CountDownLatch(1)
    val errorRef = java.util.concurrent.atomic.AtomicReference<Throwable?>()
    this.prepare(object : DownloadHelper.Callback {
      override fun onPrepared(helper: DownloadHelper) { latch.countDown() }
      override fun onPrepareError(helper: DownloadHelper, e: java.io.IOException) {
        errorRef.set(e); latch.countDown()
      }
    })
    if (!latch.await(30, java.util.concurrent.TimeUnit.SECONDS)) {
      throw java.io.IOException("DownloadHelper.prepare timed out")
    }
    errorRef.get()?.let { throw it }
    return this
  }
}
