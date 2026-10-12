import ExpoModulesCore
import AVFoundation
import UIKit
import UserNotifications

// MARK: - JS-facing records (mirror the Android module's records)

struct StartDownloadParams: Record {
  @Field var id: String = ""
  @Field var manifestUrl: String = ""
  @Field var drmLicenseUrl: String = ""
  @Field var drmToken: String = ""
  @Field var title: String? = nil
}

struct PlaybackSourceParams: Record {
  @Field var id: String = ""
}

// MARK: - Module

public class IcareOfflineDrmModule: Module {
  public func definition() -> ModuleDefinition {
    Name("IcareOfflineDrm")

    Events("onDownloadProgress")

    OnCreate {
      let manager = OfflineDownloadManager.shared
      manager.emitter = { [weak self] info in
        self?.sendEvent("onDownloadProgress", info)
      }
      manager.restore()
    }

    OnDestroy {
      OfflineDownloadManager.shared.emitter = nil
    }

    AsyncFunction("startDownload") { (params: StartDownloadParams) in
      try OfflineDownloadManager.shared.start(
        id: params.id,
        manifestUrl: params.manifestUrl,
        usesDrm: !params.drmLicenseUrl.isEmpty,
        title: params.title
      )
    }.runOnQueue(.main)

    AsyncFunction("pauseDownload") { (id: String) in
      OfflineDownloadManager.shared.pause(id: id)
    }.runOnQueue(.main)

    AsyncFunction("resumeDownload") { (id: String) in
      OfflineDownloadManager.shared.resume(id: id)
    }.runOnQueue(.main)

    AsyncFunction("removeDownload") { (id: String) in
      OfflineDownloadManager.shared.remove(id: id)
    }.runOnQueue(.main)

    AsyncFunction("listDownloads") { () -> [[String: Any?]] in
      return OfflineDownloadManager.shared.list()
    }.runOnQueue(.main)

    AsyncFunction("getDownload") { (id: String) -> [String: Any?]? in
      return OfflineDownloadManager.shared.info(id: id)
    }.runOnQueue(.main)

    AsyncFunction("getOfflineSource") { (params: PlaybackSourceParams) -> [String: Any?]? in
      return OfflineDownloadManager.shared.offlineSource(id: params.id)
    }.runOnQueue(.main)

    // Non-DRM downloads carry no license; nothing to renew. Kept for API parity.
    AsyncFunction("renewOfflineLicense") { (_: String, _: String, _: String) in }
  }
}

// MARK: - Download manager

struct OfflineDownloadError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

private struct StoredDownload: Codable {
  var id: String
  var state: String            // queued | downloading | completed | failed | stopped
  var manifestUrl: String
  var title: String?
  var relativePath: String?    // location of the .movpkg, relative to NSHomeDirectory()
  var percent: Double
  var failureReason: String?
}

final class OfflineDownloadManager: NSObject, AVAssetDownloadDelegate {
  static let shared = OfflineDownloadManager()

  /// Set by the module so progress reaches JS as `onDownloadProgress`.
  var emitter: (([String: Any?]) -> Void)?

  private let defaultsKey = "life.icare.offline.downloads.v1"
  private var stored: [String: StoredDownload] = [:]
  private var tasks: [String: AVAssetDownloadTask] = [:]

  private lazy var session: AVAssetDownloadURLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: "life.icare.offline.downloads")
    config.sessionSendsLaunchEvents = true
    return AVAssetDownloadURLSession(
      configuration: config,
      assetDownloadDelegate: self,
      delegateQueue: OperationQueue.main
    )
  }()

  private override init() {
    super.init()
    load()
  }

  // MARK: Public API (called on the main queue)

  func start(id: String, manifestUrl: String, usesDrm: Bool, title: String?) throws {
    guard !id.isEmpty else { throw OfflineDownloadError(message: "Missing download id") }
    if usesDrm {
      // FairPlay offline (persistent content keys) is not implemented yet.
      throw OfflineDownloadError(
        message: "Offline download of DRM-protected lessons is not available on iOS yet."
      )
    }
    guard let url = URL(string: manifestUrl), url.scheme?.hasPrefix("http") == true else {
      throw OfflineDownloadError(message: "Invalid stream URL")
    }
    if let existing = stored[id], existing.state == "completed", resolveLocation(existing) != nil {
      emit(existing)
      return
    }
    tasks[id]?.cancel()

    requestNotificationPermissionIfNeeded()

    let asset = AVURLAsset(url: url)
    let config = AVAssetDownloadConfiguration(asset: asset, title: title ?? "Lesson")
    let task = session.makeAssetDownloadTask(downloadConfiguration: config)
    task.taskDescription = id
    tasks[id] = task

    var record = StoredDownload(
      id: id, state: "queued", manifestUrl: manifestUrl, title: title,
      relativePath: nil, percent: 0, failureReason: nil
    )
    stored[id] = record
    save()
    emit(record)
    task.resume()
    record.state = "downloading"
    stored[id] = record
    save()
  }

  func pause(id: String) {
    guard var record = stored[id], let task = tasks[id] else { return }
    task.suspend()
    record.state = "stopped"
    stored[id] = record
    save()
    emit(record)
  }

  func resume(id: String) {
    guard var record = stored[id], let task = tasks[id] else { return }
    task.resume()
    record.state = "downloading"
    stored[id] = record
    save()
    emit(record)
  }

  func remove(id: String) {
    tasks[id]?.cancel()
    tasks[id] = nil
    if let record = stored[id] {
      if let url = resolveLocation(record) {
        try? FileManager.default.removeItem(at: url)
      }
      var removing = record
      removing.state = "removing"
      emit(removing)
    }
    stored[id] = nil
    save()
  }

  func list() -> [[String: Any?]] {
    return stored.values.map { map($0) }
  }

  func info(id: String) -> [String: Any?]? {
    guard let record = stored[id] else { return nil }
    return map(record)
  }

  func offlineSource(id: String) -> [String: Any?]? {
    guard let record = stored[id], record.state == "completed",
          let url = resolveLocation(record) else { return nil }
    return [
      "cacheKey": id,
      "uri": url.absoluteString,
      "offlineLicenseKeySetId": "",
    ]
  }

  /// Re-attach to downloads that survived an app relaunch.
  func restore() {
    session.getAllTasks { [weak self] allTasks in
      DispatchQueue.main.async {
        guard let self = self else { return }
        for task in allTasks {
          if let t = task as? AVAssetDownloadTask, let id = t.taskDescription {
            self.tasks[id] = t
          }
        }
      }
    }
  }

  // MARK: AVAssetDownloadDelegate

  func urlSession(
    _ session: URLSession,
    assetDownloadTask: AVAssetDownloadTask,
    didLoad timeRange: CMTimeRange,
    totalTimeRangesLoaded loadedTimeRanges: [NSValue],
    timeRangeExpectedToLoad: CMTimeRange
  ) {
    guard let id = assetDownloadTask.taskDescription, var record = stored[id] else { return }
    let expected = CMTimeGetSeconds(timeRangeExpectedToLoad.duration)
    guard expected.isFinite, expected > 0 else { return }
    var loaded = 0.0
    for value in loadedTimeRanges {
      let seconds = CMTimeGetSeconds(value.timeRangeValue.duration)
      if seconds.isFinite { loaded += seconds }
    }
    record.percent = min(100.0, max(0.0, (loaded / expected) * 100.0))
    record.state = "downloading"
    stored[id] = record
    emit(record)
  }

  func urlSession(
    _ session: URLSession,
    assetDownloadTask: AVAssetDownloadTask,
    willDownloadTo location: URL
  ) {
    remember(location: location, for: assetDownloadTask)
  }

  func urlSession(
    _ session: URLSession,
    assetDownloadTask: AVAssetDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    remember(location: location, for: assetDownloadTask)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = task.taskDescription, var record = stored[id] else { return }
    tasks[id] = nil
    if let error = error as NSError? {
      if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
        // Cancelled by remove(); record is already gone or reset.
        return
      }
      record.state = "failed"
      record.failureReason = error.localizedDescription
      notify(title: "Download failed", body: record.title ?? "Lesson", id: id)
    } else {
      record.state = "completed"
      record.percent = 100
      record.failureReason = nil
      notify(title: "Download complete", body: record.title ?? "Lesson ready for offline viewing", id: id)
    }
    stored[id] = record
    save()
    emit(record)
  }

  // MARK: Notifications (iOS counterpart of Android's download notification)

  private func requestNotificationPermissionIfNeeded() {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      if settings.authorizationStatus == .notDetermined {
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
      }
    }
  }

  /// Only when the app is not in the foreground (the in-app UI already shows progress).
  private func notify(title: String, body: String, id: String) {
    guard UIApplication.shared.applicationState != .active else { return }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(
      identifier: "life.icare.offline.\(id)", content: content, trigger: nil
    )
    UNUserNotificationCenter.current().add(request)
  }

  // MARK: Helpers

  private func remember(location: URL, for task: AVAssetDownloadTask) {
    guard let id = task.taskDescription, var record = stored[id] else { return }
    record.relativePath = location.relativePath
    stored[id] = record
    save()
  }

  private func resolveLocation(_ record: StoredDownload) -> URL? {
    guard let relative = record.relativePath else { return nil }
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    let url = home.appendingPathComponent(relative)
    return FileManager.default.fileExists(atPath: url.path) ? url : nil
  }

  private func map(_ record: StoredDownload) -> [String: Any?] {
    return [
      "id": record.id,
      "state": record.state,
      "bytesDownloaded": 0,
      "contentLength": -1,
      "percentDownloaded": record.percent,
      "failureReason": record.failureReason,
      "title": record.title,
    ]
  }

  private func emit(_ record: StoredDownload) {
    emitter?(map(record))
  }

  private func load() {
    guard let data = UserDefaults.standard.data(forKey: defaultsKey),
          let decoded = try? JSONDecoder().decode([String: StoredDownload].self, from: data)
    else { return }
    stored = decoded
  }

  private func save() {
    if let data = try? JSONEncoder().encode(stored) {
      UserDefaults.standard.set(data, forKey: defaultsKey)
    }
  }
}
