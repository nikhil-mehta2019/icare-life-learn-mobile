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
  @Field var thumbnailUrl: String? = nil
  @Field var durationSeconds: Double? = nil
  @Field var audioLanguages: [String]? = nil
  @Field var captionLanguages: [String]? = nil
  // iOS FairPlay (offline persistable key)
  @Field var fairplayLicenseUrl: String? = nil
  @Field var fairplayCertificateUrl: String? = nil
  @Field var licenseExpiresAt: String? = nil
}

struct PlaybackSourceParams: Record {
  @Field var id: String = ""
}

// MARK: - Offline downloads module (HLS via AVAssetDownloadURLSession)

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

    AsyncFunction("startDownload") { (params: StartDownloadParams, promise: Promise) in
      Task { @MainActor in
        do {
          try await OfflineDownloadManager.shared.start(params: params)
          promise.resolve(nil)
        } catch {
          promise.reject(error)
        }
      }
    }

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

    AsyncFunction("getStorageStats") { () -> [String: Any] in
      return OfflineDownloadManager.shared.storageStats()
    }.runOnQueue(.main)

    // Non-DRM downloads carry no license; nothing to renew. Kept for API parity.
    AsyncFunction("renewOfflineLicense") { (_: String, _: String, _: String) in }
  }
}

// MARK: - Device storage + per-download entitlement (IcareDownloadManager)

public class IcareDownloadManagerModule: Module {
  private let entitlementsKey = "life.icare.offline.entitlements.v1"

  public func definition() -> ModuleDefinition {
    Name("IcareDownloadManager")

    AsyncFunction("getDeviceStorageStats") { () -> [String: Any] in
      let home = URL(fileURLWithPath: NSHomeDirectory())
      var total: Int64 = 0
      var free: Int64 = 0
      if let values = try? home.resourceValues(forKeys: [
        .volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey,
      ]) {
        total = Int64(values.volumeTotalCapacity ?? 0)
        free = values.volumeAvailableCapacityForImportantUsage ?? 0
      }
      return [
        "totalBytes": total,
        "freeBytes": free,
        "usedBytes": max(0, total - free),
      ]
    }

    AsyncFunction("setEntitlement") {
      (id: String, courseId: String, chapterId: String, accessExpiresAt: String?) in
      var all = self.loadEntitlements()
      all[id] = [
        "courseId": courseId,
        "chapterId": chapterId,
        "accessExpiresAt": accessExpiresAt ?? "",
        "validatedAt": ISO8601DateFormatter().string(from: Date()),
      ]
      self.saveEntitlements(all)
    }

    AsyncFunction("getEntitlement") { (id: String) -> [String: Any?] in
      let stored = self.loadEntitlements()[id]
      func value(_ key: String) -> String? {
        guard let v = stored?[key], !v.isEmpty else { return nil }
        return v
      }
      return [
        "courseId": value("courseId"),
        "chapterId": value("chapterId"),
        "accessExpiresAt": value("accessExpiresAt"),
        "validatedAt": value("validatedAt"),
      ]
    }

    AsyncFunction("clearEntitlement") { (id: String) in
      var all = self.loadEntitlements()
      all[id] = nil
      self.saveEntitlements(all)
    }
  }

  private func loadEntitlements() -> [String: [String: String]] {
    return (UserDefaults.standard.dictionary(forKey: entitlementsKey) as? [String: [String: String]]) ?? [:]
  }

  private func saveEntitlements(_ value: [String: [String: String]]) {
    UserDefaults.standard.set(value, forKey: entitlementsKey)
  }
}

// MARK: - Learner language preferences (IcareLanguagePreferences)

public class IcareLanguagePreferencesModule: Module {
  private let key = "life.icare.offline.preferredLanguages.v1"

  public func definition() -> ModuleDefinition {
    Name("IcareLanguagePreferences")

    AsyncFunction("setPreferredLanguages") { (codes: [String]) -> [String] in
      let trimmed = Array(codes.prefix(3))
      UserDefaults.standard.set(trimmed, forKey: self.key)
      return trimmed
    }

    AsyncFunction("getPreferredLanguages") { () -> [String] in
      return UserDefaults.standard.stringArray(forKey: self.key) ?? []
    }
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
  var thumbnailUrl: String?
  var durationSeconds: Double?
  var relativePath: String?    // .movpkg location relative to NSHomeDirectory()
  var percent: Double
  var failureReason: String?
  var downloadedAt: String?
  var drmType: String?          // "fairplay" for protected downloads
  var licenseExpiresAt: String? // entitlement cutoff reported by the backend
}

final class OfflineDownloadManager: NSObject, AVAssetDownloadDelegate {
  static let shared = OfflineDownloadManager()

  /// Set by the module so progress reaches JS as `onDownloadProgress`.
  var emitter: (([String: Any?]) -> Void)?

  private let defaultsKey = "life.icare.offline.downloads.v1"
  private var stored: [String: StoredDownload] = [:]
  private var tasks: [String: AVAssetDownloadTask] = [:]
  /// Keeps the FairPlay key session + delegate alive while a protected download runs.
  private var keySessions: [String: (AVContentKeySession, FairPlayDownloadKeyDelegate)] = [:]

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

  func start(params: StartDownloadParams) async throws {
    let id = params.id
    guard !id.isEmpty else { throw OfflineDownloadError(message: "Missing download id") }
    let wantsDrm = !params.drmLicenseUrl.isEmpty
      || !(params.fairplayLicenseUrl ?? "").isEmpty
      || !(params.fairplayCertificateUrl ?? "").isEmpty
    var fairPlay: (license: URL, certificate: URL)? = nil
    if wantsDrm {
      guard let licenseString = params.fairplayLicenseUrl, let license = URL(string: licenseString),
            let certString = params.fairplayCertificateUrl, let certificate = URL(string: certString)
      else {
        throw OfflineDownloadError(
          message: "Offline download of DRM-protected lessons is not available on iOS yet."
        )
      }
      fairPlay = (license, certificate)
      #if targetEnvironment(simulator)
      // AVContentKeySession raises an uncatchable NSInvalidArgumentException for
      // FairPlay in the Simulator (key system unsupported). Fail with a message
      // instead of crashing; protected downloads need a physical iPhone.
      throw OfflineDownloadError(
        message: "Protected lessons can only be downloaded on a physical iPhone, not in the Simulator."
      )
      #endif
    }
    guard let url = URL(string: params.manifestUrl), url.scheme?.hasPrefix("http") == true else {
      throw OfflineDownloadError(message: "Invalid stream URL")
    }
    if let existing = stored[id], existing.state == "completed", resolveLocation(existing) != nil {
      emit(existing)
      return
    }
    tasks[id]?.cancel()
    requestNotificationPermissionIfNeeded()

    let asset = AVURLAsset(url: url)

    // FairPlay: obtain a persistable content key while the HLS download runs.
    if let fairPlay = fairPlay {
      let delegate = FairPlayDownloadKeyDelegate(
        downloadId: id,
        certificateUrl: fairPlay.certificate,
        licenseUrl: fairPlay.license,
        drmToken: params.drmToken.isEmpty ? nil : params.drmToken
      )
      delegate.onFailure = { [weak self] reason in
        DispatchQueue.main.async { self?.failDownload(id: id, reason: reason) }
      }
      let keySession = AVContentKeySession(keySystem: .fairPlayStreaming)
      keySession.setDelegate(delegate, queue: DispatchQueue.main)
      keySession.addContentKeyRecipient(asset)
      // Without this AVFoundation never requests the key during an offline download,
      // so no persistable key is stored (observed on device: video complete, key missing).
      asset.resourceLoader.preloadsEligibleContentKeys = true
      keySessions[id] = (keySession, delegate)
      FairPlayDiag.log(id, "key session created; recipient added; preloadsEligibleContentKeys=true")
    }

    let config = AVAssetDownloadConfiguration(asset: asset, title: params.title ?? "Lesson")

    // Honour the learner's audio/caption language choice when the stream offers it.
    if let selection = await mediaSelection(
      for: asset,
      audio: params.audioLanguages ?? [],
      captions: params.captionLanguages ?? []
    ) {
      config.primaryContentConfiguration.mediaSelections = [selection]
    }

    let task = session.makeAssetDownloadTask(downloadConfiguration: config)
    task.taskDescription = id
    tasks[id] = task

    var record = StoredDownload(
      id: id, state: "queued", manifestUrl: params.manifestUrl, title: params.title,
      thumbnailUrl: params.thumbnailUrl, durationSeconds: params.durationSeconds,
      relativePath: nil, percent: 0, failureReason: nil, downloadedAt: nil,
      drmType: fairPlay != nil ? "fairplay" : nil,
      licenseExpiresAt: params.licenseExpiresAt
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
    keySessions[id] = nil
    FairPlayKeychain.delete(id: id)
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
      "drmType": record.drmType,
    ]
  }

  func storageStats() -> [String: Any] {
    var bytes: Int64 = 0
    var count = 0
    for record in stored.values where record.state == "completed" {
      guard let url = resolveLocation(record) else { continue }
      count += 1
      bytes += directorySize(url)
    }
    return ["usedBytes": bytes, "downloadCount": count]
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
    keySessions[id] = nil
    FairPlayDiag.log(id, "download task finished: error=\(error.map { ($0 as NSError).domain + "/" + String(($0 as NSError).code) } ?? "none") drm=\(record.drmType ?? "none") keyStored=\(FairPlayKeychain.exists(id: id))")
    if let error = error as NSError? {
      if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
        // Cancelled by remove(); record is already gone or reset.
        return
      }
      record.state = "failed"
      record.failureReason = error.localizedDescription
      notify(title: "Download failed", body: record.title ?? "Lesson", id: id)
    } else if record.drmType == "fairplay" && !FairPlayKeychain.exists(id: id) {
      record.state = "failed"
      record.failureReason = "The protected lesson downloaded but its licence key was not stored."
      notify(title: "Download failed", body: record.title ?? "Lesson", id: id)
    } else {
      record.state = "completed"
      record.percent = 100
      record.failureReason = nil
      record.downloadedAt = ISO8601DateFormatter().string(from: Date())
      notify(title: "Download complete", body: record.title ?? "Lesson ready for offline viewing", id: id)
    }
    stored[id] = record
    save()
    emit(record)
  }

  // MARK: Language selection

  private func mediaSelection(
    for asset: AVURLAsset, audio: [String], captions: [String]
  ) async -> AVMediaSelection? {
    guard !audio.isEmpty || !captions.isEmpty else { return nil }
    var changed = false
    do {
      let preferred = try await asset.load(.preferredMediaSelection)
      guard let mutable = preferred.mutableCopy() as? AVMutableMediaSelection else { return nil }
      if !audio.isEmpty,
         let group = try await asset.loadMediaSelectionGroup(for: .audible),
         let option = bestOption(in: group, languages: audio) {
        mutable.select(option, in: group)
        changed = true
      }
      if !captions.isEmpty,
         let group = try await asset.loadMediaSelectionGroup(for: .legible),
         let option = bestOption(in: group, languages: captions) {
        mutable.select(option, in: group)
        changed = true
      }
      return changed ? mutable : nil
    } catch {
      return nil
    }
  }

  private func bestOption(
    in group: AVMediaSelectionGroup, languages: [String]
  ) -> AVMediaSelectionOption? {
    for wanted in languages {
      let base = wanted.lowercased().replacingOccurrences(of: "_", with: "-")
        .split(separator: "-").first.map(String.init) ?? wanted.lowercased()
      if let match = group.options.first(where: {
        ($0.locale?.language.languageCode?.identifier ?? "").lowercased() == base
      }) {
        return match
      }
    }
    return nil
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

  private func failDownload(id: String, reason: String) {
    tasks[id]?.cancel()
    tasks[id] = nil
    keySessions[id] = nil
    guard var record = stored[id] else { return }
    record.state = "failed"
    record.failureReason = reason
    stored[id] = record
    save()
    emit(record)
    notify(title: "Download failed", body: record.title ?? "Lesson", id: id)
  }

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

  private func directorySize(_ url: URL) -> Int64 {
    guard let enumerator = FileManager.default.enumerator(
      at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .fileSizeKey]
    ) else { return 0 }
    var total: Int64 = 0
    for case let file as URL in enumerator {
      let values = try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .fileSizeKey])
      total += Int64(values?.totalFileAllocatedSize ?? values?.fileSize ?? 0)
    }
    return total
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
      "downloadedAt": record.downloadedAt,
      "thumbnailUrl": record.thumbnailUrl,
      "durationSeconds": record.durationSeconds,
      "drmType": record.drmType,
      "licenseExpiresAt": record.licenseExpiresAt,
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

// MARK: - FairPlay offline keys

/// Stores the persistable FairPlay content key per download in the Keychain.
enum FairPlayKeychain {
  private static let service = "life.icare.offline.fairplay.keys"

  private static func query(_ id: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: id,
    ]
  }

  static func save(_ data: Data, id: String) {
    SecItemDelete(query(id) as CFDictionary)
    var item = query(id)
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(item as CFDictionary, nil)
  }

  static func load(id: String) -> Data? {
    var q = query(id)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  static func exists(id: String) -> Bool { return load(id: id) != nil }

  static func delete(id: String) {
    SecItemDelete(query(id) as CFDictionary)
  }
}

/// Answers the key requests raised while an HLS asset is being downloaded:
/// fetch the app certificate, build the SPC, exchange it for a CKC at the
/// licence server, persist the resulting offline key.
final class FairPlayDownloadKeyDelegate: NSObject, AVContentKeySessionDelegate {
  private let downloadId: String
  private let certificateUrl: URL
  private let licenseUrl: URL
  private let drmToken: String?
  var onFailure: ((String) -> Void)?
  private var certificate: Data?

  init(downloadId: String, certificateUrl: URL, licenseUrl: URL, drmToken: String?) {
    self.downloadId = downloadId
    self.certificateUrl = certificateUrl
    self.licenseUrl = licenseUrl
    self.drmToken = drmToken
    super.init()
  }

  // Ask for a persistable key so the licence can be reused offline.
  func contentKeySession(_ session: AVContentKeySession, didProvide keyRequest: AVContentKeyRequest) {
    FairPlayDiag.log(downloadId, "didProvide AVContentKeyRequest id=\(FairPlayDiag.describe(keyRequest.identifier))")
    do {
      try keyRequest.respondByRequestingPersistableContentKeyRequestAndReturnError()
    } catch {
      onFailure?("FairPlay: could not request a persistable key (\(error.localizedDescription))")
    }
  }

  func contentKeySession(
    _ session: AVContentKeySession, didProvide keyRequest: AVPersistableContentKeyRequest
  ) {
    FairPlayDiag.log(downloadId, "didProvide AVPersistableContentKeyRequest id=\(FairPlayDiag.describe(keyRequest.identifier))")
    guard let identifier = keyRequest.identifier as? String,
          let skd = URL(string: identifier),
          let contentId = (skd.host ?? identifier).data(using: .utf8)
    else {
      onFailure?("FairPlay: missing content key identifier")
      return
    }

    fetchCertificate { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure(let error):
        FairPlayDiag.log(self.downloadId, "certificate FAILED: \(error.localizedDescription)")
        self.onFailure?("FairPlay certificate: \(error.localizedDescription)")
      case .success(let certificate):
        FairPlayDiag.log(self.downloadId, "certificate ok (\(certificate.count) bytes)")
        keyRequest.makeStreamingContentKeyRequestData(
          forApp: certificate,
          contentIdentifier: contentId,
          options: [AVContentKeyRequestProtocolVersionsKey: [1]]
        ) { spc, error in
          guard let spc = spc, error == nil else {
            FairPlayDiag.log(self.downloadId, "SPC FAILED: \(error?.localizedDescription ?? "unknown")")
            self.onFailure?("FairPlay SPC: \(error?.localizedDescription ?? "unknown error")")
            return
          }
          FairPlayDiag.log(self.downloadId, "SPC built (\(spc.count) bytes); requesting licence")
          self.requestKeyResponse(spc: spc) { ckcResult in
            switch ckcResult {
            case .failure(let error):
              FairPlayDiag.log(self.downloadId, "licence FAILED: \(error.localizedDescription)")
              self.onFailure?("FairPlay licence: \(error.localizedDescription)")
            case .success(let ckc):
              FairPlayDiag.log(self.downloadId, "licence ok (\(ckc.count) bytes)")
              do {
                let persistentKey = try keyRequest.persistableContentKey(
                  fromKeyVendorResponse: ckc, options: nil
                )
                FairPlayKeychain.save(persistentKey, id: self.downloadId)
                FairPlayDiag.log(self.downloadId, "persistent key saved to Keychain (\(persistentKey.count) bytes)")
                keyRequest.processContentKeyResponse(
                  AVContentKeyResponse(fairPlayStreamingKeyResponseData: persistentKey)
                )
              } catch {
                FairPlayDiag.log(self.downloadId, "persistable key FAILED: \(error.localizedDescription)")
                self.onFailure?("FairPlay key: \(error.localizedDescription)")
              }
            }
          }
        }
      }
    }
  }

  func contentKeySession(
    _ session: AVContentKeySession, contentKeyRequest keyRequest: AVContentKeyRequest,
    didFailWithError err: Error
  ) {
    FairPlayDiag.log(downloadId, "content key request FAILED: \(err.localizedDescription)")
    onFailure?("FairPlay: \(err.localizedDescription)")
  }

  // MARK: Networking

  private func fetchCertificate(_ completion: @escaping (Result<Data, Error>) -> Void) {
    if let certificate = certificate { return completion(.success(certificate)) }
    var request = URLRequest(url: withToken(certificateUrl))
    request.timeoutInterval = 30
    if let token = drmToken { request.setValue(token, forHTTPHeaderField: "x-mux-license-token") }
    URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      if let error = error { return completion(.failure(error)) }
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let data = data, !data.isEmpty
      else {
        let code = (response as? HTTPURLResponse)?.statusCode ?? -1
        FairPlayDiag.log(self?.downloadId ?? "?", "certificate HTTP \(code), \(data?.count ?? 0) bytes")
        return completion(.failure(OfflineDownloadError(message: "certificate request failed (HTTP \(code))")))
      }
      self?.certificate = data
      completion(.success(data))
    }.resume()
  }

  private func requestKeyResponse(spc: Data, _ completion: @escaping (Result<Data, Error>) -> Void) {
    var request = URLRequest(url: withToken(licenseUrl))
    request.httpMethod = "POST"
    request.timeoutInterval = 30
    request.httpBody = spc
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    if let token = drmToken { request.setValue(token, forHTTPHeaderField: "x-mux-license-token") }
    URLSession.shared.dataTask(with: request) { data, response, error in
      if let error = error { return completion(.failure(error)) }
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let data = data, !data.isEmpty
      else {
        let code = (response as? HTTPURLResponse)?.statusCode ?? -1
        FairPlayDiag.log(self.downloadId, "licence HTTP \(code), \(data?.count ?? 0) bytes")
        return completion(.failure(OfflineDownloadError(message: "licence request failed (HTTP \(code))")))
      }
      completion(.success(FairPlayDownloadKeyDelegate.normalizeKeyResponse(data)))
    }.resume()
  }

  /// Some servers answer with the CKC base64-encoded (optionally wrapped in <ckc> tags).
  private static func normalizeKeyResponse(_ data: Data) -> Data {
    guard var text = String(data: data, encoding: .utf8) else { return data }
    text = text.replacingOccurrences(of: "<ckc>", with: "")
      .replacingOccurrences(of: "</ckc>", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
    if !text.isEmpty, text.unicodeScalars.allSatisfy({ allowed.contains($0) }),
       let decoded = Data(base64Encoded: text) {
      return decoded
    }
    return data
  }

  /// Mux accepts the licence JWT as a `token` query parameter; add it when missing.
  private func withToken(_ url: URL) -> URL {
    guard let token = drmToken, !token.isEmpty,
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return url }
    var items = components.queryItems ?? []
    if !items.contains(where: { $0.name == "token" }) {
      items.append(URLQueryItem(name: "token", value: token))
      components.queryItems = items
    }
    return components.url ?? url
  }
}

/// Small on-device trail of FairPlay steps (no tokens or key material), kept in
/// UserDefaults under `life.icare.offline.fairplay.diag` so it can be pulled from
/// a device with `devicectl ... copy from` for troubleshooting.
enum FairPlayDiag {
  private static let key = "life.icare.offline.fairplay.diag"
  private static let lock = NSLock()

  static func log(_ id: String, _ message: String) {
    lock.lock(); defer { lock.unlock() }
    let stamp = ISO8601DateFormatter().string(from: Date())
    var lines = UserDefaults.standard.stringArray(forKey: key) ?? []
    lines.append("\(stamp) [\(id.prefix(8))] \(message)")
    if lines.count > 200 { lines.removeFirst(lines.count - 200) }
    UserDefaults.standard.set(lines, forKey: key)
  }

  /// Key identifiers are skd:// URIs; log scheme/host only.
  static func describe(_ identifier: Any?) -> String {
    guard let text = identifier as? String else { return String(describing: identifier) }
    if let url = URL(string: text), let host = url.host { return "\(url.scheme ?? "?")://\(host.prefix(12))…" }
    return "\(text.prefix(24))…"
  }
}
