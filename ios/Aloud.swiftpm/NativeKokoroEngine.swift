import CryptoKit
import Foundation
import KokoroSwift
import MLX
import MLXUtilsLibrary

/// Stable sandbox locations shared by the native engine and the loopback
/// server. Generated clips are deliberately ephemeral; the model is not.
enum NativeKokoroPaths {
    static func audioDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return try makeDirectory(base.appendingPathComponent("AloudKokoroAudio", isDirectory: true))
    }

    static func downloadedModelDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return try makeDirectory(
            base.appendingPathComponent("Aloud", isDirectory: true)
                .appendingPathComponent("Kokoro-v1.0-bf16", isDirectory: true)
        )
    }

    @discardableResult
    private static func makeDirectory(_ url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
        return url
    }
}

/// Full-quality Kokoro inference for the iOS app.
///
/// The model and every MLXArray stay on one serial queue. Only a short-lived
/// WAV URL and small timestamp metadata cross into WebKit, so the 327 MB model
/// never enters WebKit's memory-limited process.
final class NativeKokoroEngine {

    static let shared = NativeKokoroEngine()

    static let sampleRate = 24_000
    static let modelFileName = "kokoro-v1_0.safetensors"
    static let expectedModelBytes: Int64 = 327_115_152
    static let expectedModelSHA256 = "4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8"
    static let expectedVoicesSHA256 = "56dbfa2f2970af2e395397020393d368c5f441d09b3de4e9b77f6222e790f10f"
    static let modelURL = URL(string: "https://huggingface.co/mlx-community/Kokoro-82M-bf16/resolve/64db71c5eddbb2f96f51829e77105bb79f23ba98/kokoro-v1_0.safetensors")!
    private static let mlxCacheLimitBytes = 50 * 1_024 * 1_024
    // The model and voices occupy about 326 MiB of live MLX storage. 768 MiB
    // leaves roughly 440 MiB for sentence-sized decoder activations while
    // keeping the allocator well below its roughly 900 MiB device default.
    // MLX treats this as an allocation-pressure threshold, not a guarantee
    // that one indivisible live graph can never exceed it.
    private static let mlxMemoryLimitBytes = 768 * 1_024 * 1_024

    /// Events use JSON-compatible values. Replies are safe to broadcast because
    /// each page nonce makes request IDs globally unique; pages ignore replies
    /// that are not theirs. A handler collection also prevents a second iPad
    /// window from stealing the first window's callback.
    private let eventLock = NSLock()
    private var eventHandlers: [UUID: ([String: Any]) -> Void] = [:]

    private enum State {
        case idle
        case preparing
        case waitingForForeground
        case ready
    }

    private struct GenerationReservation {
        let requestID: String
        let admittedAt: Date
    }

    private let queue = DispatchQueue(label: "com.westsmith.aloud.kokoro", qos: .userInitiated)
    // Lifecycle/health events must never wait behind the MLX queue. Keeping
    // their own serial order also guarantees that a foreground `busy` report is
    // delivered before the matching one-shot `idle` report.
    private let lifecycleEventQueue = DispatchQueue(
        label: "com.westsmith.aloud.kokoro.lifecycle-events",
        qos: .userInitiated
    )
    private let cancellationLock = NSLock()
    private var cancelledRequestIDs = Set<String>()
    private let activityLock = NSLock()
    // Lifecycle callbacks update this immediately, even if `queue` is occupied
    // hashing a model. That lets the next safe checkpoint see the transition
    // before it submits new Metal work. Default closed protects cold launch.
    private var appActive = false
    private let healthLock = NSLock()
    // Generation admission is reserved synchronously at the bridge boundary,
    // before work is dispatched to `queue`. Lifecycle diagnostics therefore
    // remain readable even when that serial queue (or MLX itself) is stranded,
    // and two WebViews cannot both enqueue native inference.
    private var generationReservation: GenerationReservation?
    private var reportIdleWhenGenerationFinishes = false

    // Accessed only on `queue`.
    private var state: State = .idle
    private var waitingPrepareIDs: [String] = []
    private var tts: KokoroTTS?
    private var voices: [String: MLXArray] = [:]
    private var downloader: NativeKokoroDownloader?
    private var rejectedBundledModel = false

    private init() {
        queue.async { [weak self] in self?.pruneOldAudioFiles() }
    }

    @discardableResult
    func addEventHandler(_ handler: @escaping ([String: Any]) -> Void) -> UUID {
        let identifier = UUID()
        eventLock.lock()
        eventHandlers[identifier] = handler
        eventLock.unlock()
        return identifier
    }

    func removeEventHandler(_ identifier: UUID) {
        eventLock.lock()
        eventHandlers.removeValue(forKey: identifier)
        eventLock.unlock()
    }

    /// UIKit/SwiftUI lifecycle code must set this false as soon as the app
    /// resigns active. iOS rejects newly submitted Metal command buffers while
    /// an app is in the background, even when background audio is enabled.
    func setAppActive(_ active: Bool, publishEvenIfUnchanged: Bool = false) {
        activityLock.lock()
        let changed = appActive != active
        appActive = active
        activityLock.unlock()

        // Do not enqueue the lifecycle event behind model verification or MLX
        // inference. JavaScript needs the foreground signal in order to recover
        // its transport, and `appActive` above is already the authoritative gate
        // before this event can cross the bridge.
        /* Bridge commands such as generate and audio reactivation refresh this
           value defensively. They must not masquerade as lifecycle changes:
           an unchanged busy report can overtake the command's reply and make
           JavaScript cancel the fresh request it just started. Only real
           transitions and an explicit health refresh publish an event. */
        let health = (changed || publishEvenIfUnchanged)
            ? publishActivity(active)
            : (busy: false, busySeconds: 0)
        if changed {
            let detail = health.busy ? " (MLX busy for \(health.busySeconds)s)" : ""
            print("[Aloud] Native Kokoro app activity: \(active ? "active" : "inactive")\(detail)")
        }

        queue.async { [weak self] in
            guard let self else { return }
            // A newer lifecycle callback may have overtaken this queued work
            // while hashing or inference occupied the serial queue. Act only
            // on the current authoritative value, never a stale event.
            guard self.isAppActive == active else { return }

            guard self.state == .waitingForForeground else { return }
            guard !self.waitingPrepareIDs.isEmpty else {
                self.state = .idle
                return
            }
            guard active else { return }

            self.state = .preparing
            print("[Aloud] Native Kokoro resuming deferred preparation")
            self.beginPreparation()
        }
    }

    func prepare(requestID: String) {
        queue.async { [weak self] in
            guard let self else { return }
            guard !self.consumeCancellation(requestID) else { return }
            if self.state == .ready {
                self.replySuccess(
                    requestID: requestID,
                    result: [
                        "ready": true,
                        "sampleRate": Self.sampleRate,
                        "quality": "bf16",
                        "voiceCount": self.voices.count,
                    ]
                )
                return
            }

            self.waitingPrepareIDs.append(requestID)
            guard self.state == .idle else { return }
            self.state = .preparing
            if self.isAppActive {
                self.beginPreparation()
            } else {
                self.deferPreparationUntilForeground()
            }
        }
    }

    func generate(requestID: String, text: String, voiceName: String) {
        // Reject at the bridge boundary as well as on the serial queue below.
        // This keeps requests made during suspension from accumulating behind a
        // long inference and makes the page's foreground retry settle promptly.
        guard isAppActive else {
            replyFailure(
                requestID: requestID,
                code: "app_inactive",
                message: "Return to Aloud before creating more Kokoro speech.",
                retryable: true
            )
            return
        }

        // Reserve synchronously instead of checking a marker that is set later
        // on `queue`. This is the single admission boundary shared by every
        // scene, including two iPad windows racing in the same run loop turn.
        guard reserveGeneration(requestID: requestID) else { return }

        // The singleton is intentionally retained until this admitted request
        // reaches an owner-checked release. A weak capture could theoretically
        // abandon the reservation before the defensive defer is installed.
        queue.async { [self] in
            defer { self.releaseGenerationReservation(requestID: requestID) }
            guard !self.consumeCancellation(requestID) else { return }
            guard self.state == .ready, let tts = self.tts else {
                self.replyGenerationFailure(
                    requestID: requestID,
                    code: "model_not_ready",
                    message: "Kokoro is not ready yet.",
                    retryable: true
                )
                return
            }
            guard self.isAppActive else {
                self.replyGenerationFailure(
                    requestID: requestID,
                    code: "app_inactive",
                    message: "Return to Aloud before creating more Kokoro speech.",
                    retryable: true
                )
                return
            }

            let cleanText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanText.isEmpty else {
                self.replyGenerationFailure(
                    requestID: requestID,
                    code: "empty_text",
                    message: "There is no pronounceable text in this segment.",
                    retryable: false
                )
                return
            }

            let voiceKey = voiceName.hasSuffix(".npy") ? voiceName : "\(voiceName).npy"
            guard let voice = self.voices[voiceKey] else {
                self.replyGenerationFailure(
                    requestID: requestID,
                    code: "bad_voice",
                    message: "The selected Kokoro voice is unavailable.",
                    retryable: false
                )
                return
            }

            do {
                // The returned [Float] has forced the lazy graph to complete.
                // Clear recyclable Metal buffers after writing it, and on every
                // throw/cancellation path through this inference scope.
                defer { Memory.clearCache() }

                self.emitProgress(
                    stage: "generating",
                    message: "Creating speech on this iPad…",
                    progress: 0
                )

                guard self.isAppActive else {
                    throw NativeKokoroFailure(
                        code: "app_inactive",
                        message: "Return to Aloud before creating more Kokoro speech.",
                        retryable: true
                    )
                }
                // Pause/background cancellation can race the validation and
                // progress work above. This is the first checkpoint; the
                // vendored pipeline repeats it immediately before each forced
                // lazy MLX evaluation.
                guard !self.consumeCancellation(requestID) else { return }
                let language: Language = voiceName.lowercased().hasPrefix("b") ? .enGB : .enUS
                let (samples, tokens) = try tts.generateAudio(
                    voice: voice,
                    language: language,
                    text: cleanText,
                    speed: 1.0,
                    checkpoint: {
                        // Observe cancellation without consuming its tombstone.
                        // The catch below remains the generation's one terminal
                        // consumer and the queued cancel cleanup stays idempotent.
                        if self.isCancellationPending(requestID) {
                            throw NativeKokoroGenerationCancelled()
                        }
                        guard self.isAppActive else {
                            throw NativeKokoroFailure(
                                code: "app_inactive",
                                message: "Return to Aloud before creating more Kokoro speech.",
                                retryable: true
                            )
                        }
                    }
                )

                guard !samples.isEmpty else {
                    throw NativeKokoroFailure(
                        code: "generation_failed",
                        message: "Kokoro returned an empty audio clip.",
                        retryable: true
                    )
                }
                guard !self.consumeCancellation(requestID) else { return }

                let audioID = UUID().uuidString.lowercased()
                let audioDirectory = try NativeKokoroPaths.audioDirectory()
                let finalURL = audioDirectory.appendingPathComponent("\(audioID).wav")
                try Self.writePCM16WAV(samples: samples, to: finalURL)

                guard !self.consumeCancellation(requestID) else {
                    try? FileManager.default.removeItem(at: finalURL)
                    return
                }

                let duration = Double(samples.count) / Double(Self.sampleRate)
                let lowThresholdLead = Self.leadingSilence(in: samples)
                let timestampShift = Self.timestampShift(tokens: tokens ?? [], measuredLead: lowThresholdLead)
                let tokenPayload = (tokens ?? []).map {
                    Self.tokenPayload($0, shift: timestampShift, duration: duration)
                }

                let delivered = self.replyGenerationSuccess(
                    requestID: requestID,
                    result: [
                        "audioId": audioID,
                        // Resolve against the requesting scene's loopback port.
                        "url": "/__aloud_kokoro/\(audioID).wav",
                        "samplingRate": Self.sampleRate,
                        "durationSec": duration,
                        "leadSec": lowThresholdLead,
                        "tokens": tokenPayload,
                    ]
                )
                if !delivered { try? FileManager.default.removeItem(at: finalURL) }
                self.trimAudioCache(keeping: 32)
            } catch is NativeKokoroGenerationCancelled {
                _ = self.consumeCancellation(requestID)
                return
            } catch KokoroTTS.KokoroTTSError.tooManyTokens {
                self.replyGenerationFailure(
                    requestID: requestID,
                    code: "too_many_tokens",
                    message: "This text segment is too long for Kokoro.",
                    retryable: true
                )
            } catch let failure as NativeKokoroFailure {
                self.replyGenerationFailure(
                    requestID: requestID,
                    code: failure.code,
                    message: failure.message,
                    retryable: failure.retryable
                )
            } catch {
                self.replyGenerationFailure(
                    requestID: requestID,
                    code: "generation_failed",
                    message: "Kokoro could not create this sentence: \(error.localizedDescription)",
                    retryable: true
                )
            }
        }
    }

    /// MLX calls cannot be interrupted safely in the middle of a GPU kernel.
    /// Cancellation is observed at the next vendor evaluation checkpoint; a
    /// kernel already in flight still runs to its natural completion.
    func cancel(requestID: String) {
        cancellationLock.lock()
        cancelledRequestIDs.insert(requestID)
        cancellationLock.unlock()

        // Preparation remains app-scoped and can finish for another page, but
        // this page must not remain a waiter or leak a cancellation tombstone.
        queue.async { [weak self] in
            guard let self else { return }
            self.waitingPrepareIDs.removeAll { $0 == requestID }
            if self.waitingPrepareIDs.isEmpty, self.state == .waitingForForeground {
                self.state = .idle
            }
            self.clearCancellation(requestID)
        }
    }

    func release(audioID: String) {
        guard UUID(uuidString: audioID) != nil else { return }
        queue.async {
            guard let directory = try? NativeKokoroPaths.audioDirectory() else { return }
            try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(audioID.lowercased()).wav"))
        }
    }

    // MARK: - Model preparation

    private func beginPreparation() {
        guard isAppActive else {
            deferPreparationUntilForeground()
            return
        }
        emitProgress(stage: "checking-model", message: "Checking the full-quality Kokoro model…", progress: 1)

        if !rejectedBundledModel,
           let bundled = bundledResource(name: "kokoro-v1_0", extension: "safetensors"),
           fileSize(bundled) == Self.expectedModelBytes {
            validateAndOpenModel(at: bundled, source: "included")
            return
        }

        do {
            let modelDirectory = try NativeKokoroPaths.downloadedModelDirectory()
            let finalURL = modelDirectory.appendingPathComponent(Self.modelFileName)
            let partialURL = modelDirectory.appendingPathComponent("\(Self.modelFileName).partial")

            if fileSize(finalURL) == Self.expectedModelBytes {
                validateAndOpenModel(at: finalURL, source: "downloaded")
                return
            }
            if FileManager.default.fileExists(atPath: finalURL.path) {
                try? FileManager.default.removeItem(at: finalURL)
            }

            // A completed partial file may only be waiting for verification
            // after an interrupted launch.
            if fileSize(partialURL) == Self.expectedModelBytes {
                validateDownloadedPartial(partialURL, finalURL: finalURL)
                return
            }

            guard Self.availableDiskCapacity(at: modelDirectory) >= 700_000_000 else {
                throw NativeKokoroFailure(
                    code: "not_enough_space",
                    message: "Kokoro needs about 700 MB of free space for its one-time model setup.",
                    retryable: true
                )
            }

            emitProgress(
                stage: "downloading-model",
                message: "Downloading the full-quality Kokoro model once…",
                progress: 2,
                loaded: fileSize(partialURL),
                total: Self.expectedModelBytes
            )

            let downloader = NativeKokoroDownloader(
                source: Self.modelURL,
                destination: partialURL,
                expectedBytes: Self.expectedModelBytes,
                progress: { [weak self] loaded, total in
                    self?.emitProgress(
                        stage: "downloading-model",
                        message: "Downloading the full-quality Kokoro model once…",
                        progress: max(2, min(90, Int((Double(loaded) / Double(total)) * 88) + 2)),
                        loaded: loaded,
                        total: total
                    )
                },
                completion: { [weak self] result in
                    guard let self else { return }
                    self.queue.async {
                        self.downloader = nil
                        switch result {
                        case .success:
                            self.validateDownloadedPartial(partialURL, finalURL: finalURL)
                        case .failure(let error):
                            self.finishPreparation(
                                failure: NativeKokoroFailure(
                                    code: "model_download_failed",
                                    message: "The Kokoro model download stopped: \(error.localizedDescription). Tap Kokoro to resume it.",
                                    retryable: true
                                )
                            )
                        }
                    }
                }
            )
            self.downloader = downloader
            downloader.start()
        } catch let failure as NativeKokoroFailure {
            finishPreparation(failure: failure)
        } catch {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "model_setup_failed",
                    message: "Kokoro could not prepare its model storage: \(error.localizedDescription)",
                    retryable: true
                )
            )
        }
    }

    private func validateDownloadedPartial(_ partialURL: URL, finalURL: URL) {
        guard isAppActive else {
            deferPreparationUntilForeground()
            return
        }
        guard fileSize(partialURL) == Self.expectedModelBytes else {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "model_download_incomplete",
                    message: "The Kokoro model download is incomplete. Tap Kokoro to resume it.",
                    retryable: true
                )
            )
            return
        }

        do {
            let digest = try hashModel(at: partialURL, progressStart: 90, progressEnd: 97)
            guard digest == Self.expectedModelSHA256 else {
                try? FileManager.default.removeItem(at: partialURL)
                throw NativeKokoroFailure(
                    code: "model_verification_failed",
                    message: "The downloaded Kokoro model was damaged. It was removed so the next try can download a clean copy.",
                    retryable: true
                )
            }
            try? FileManager.default.removeItem(at: finalURL)
            try FileManager.default.moveItem(at: partialURL, to: finalURL)
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: finalURL.path
            )
            openVerifiedModel(at: finalURL, source: "downloaded")
        } catch let failure as NativeKokoroFailure {
            finishPreparation(failure: failure)
        } catch {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "model_verification_failed",
                    message: "Kokoro could not verify its model: \(error.localizedDescription)",
                    retryable: true
                )
            )
        }
    }

    private func validateAndOpenModel(at url: URL, source: String) {
        guard isAppActive else {
            deferPreparationUntilForeground()
            return
        }
        do {
            let digest = try hashModel(at: url, progressStart: 4, progressEnd: 35)
            guard digest == Self.expectedModelSHA256 else {
                if source == "included" { rejectedBundledModel = true }
                else { try? FileManager.default.removeItem(at: url) }
                // A checkout may contain Git LFS's pointer instead of the real
                // model. Fall back to the resumable pinned download.
                state = .idle
                state = .preparing
                beginPreparationWithoutCandidate(at: url)
                return
            }
            openVerifiedModel(at: url, source: source)
        } catch {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "model_verification_failed",
                    message: "Kokoro could not verify its model: \(error.localizedDescription)",
                    retryable: true
                )
            )
        }
    }

    /// Re-enters preparation after rejecting a same-sized but wrong candidate.
    /// The downloaded candidate is removed first, so this cannot loop.
    private func beginPreparationWithoutCandidate(at rejectedURL: URL) {
        if rejectedURL.path.contains("Application Support") {
            try? FileManager.default.removeItem(at: rejectedURL)
        }
        // If the rejected candidate was bundled, preserve and verify any valid
        // model already downloaded by an earlier app build. If it was the
        // downloaded candidate itself, it was removed above.
        beginPreparation()
    }

    private func openVerifiedModel(at modelURL: URL, source: String) {
        guard isAppActive else {
            deferPreparationUntilForeground()
            return
        }
        guard let voicesURL = bundledResource(name: "voices", extension: "npz") else {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "voices_missing",
                    message: "The Kokoro voice pack is missing from this app build.",
                    retryable: false
                )
            )
            return
        }
        let voicesDigest: String
        do {
            voicesDigest = try hashFile(at: voicesURL)
        } catch {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "voices_invalid",
                    message: "The included Kokoro voice pack could not be verified: \(error.localizedDescription)",
                    retryable: false
                )
            )
            return
        }
        guard fileSize(voicesURL) == 14_629_684,
              voicesDigest == Self.expectedVoicesSHA256 else {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "voices_invalid",
                    message: "The included Kokoro voice pack is invalid.",
                    retryable: false
                )
            )
            return
        }
        // NpyzReader creates MLXArray values. Recheck after the CPU-only hash
        // so a scene that resigned active during verification does not begin
        // allocating MLX resources in the background.
        guard isAppActive else {
            deferPreparationUntilForeground()
            return
        }
        // Do not touch MLX until the scene is active. Its defaults are based on
        // Metal's working set and are too generous for a process owning WebKit.
        Self.configureMLXMemory()
        guard let loadedVoices = NpyzReader.read(fileFromPath: voicesURL),
              loadedVoices.count == 28 else {
            finishPreparation(
                failure: NativeKokoroFailure(
                    code: "voices_invalid",
                    message: "The included Kokoro voice pack is invalid.",
                    retryable: false
                )
            )
            return
        }

        emitProgress(
            stage: "loading-model",
            message: "Opening the full-quality model with Apple MLX…",
            progress: 97
        )

        // Upstream KokoroTTS currently force-unwraps required tensors. The
        // exact byte count + SHA check above is therefore a safety boundary,
        // not merely a cache check.
        guard isAppActive else {
            deferPreparationUntilForeground()
            return
        }
        Self.configureMLXMemory()
        let engine = KokoroTTS(modelPath: modelURL, g2p: .misaki)
        self.tts = engine
        self.voices = loadedVoices
        self.state = .ready
        Memory.clearCache()

        emitProgress(stage: "ready", message: "Kokoro is ready and stays on this device.", progress: 100)
        let requestIDs = waitingPrepareIDs
        waitingPrepareIDs.removeAll()
        for requestID in requestIDs {
            replySuccess(
                requestID: requestID,
                result: [
                    "ready": true,
                    "sampleRate": Self.sampleRate,
                    "quality": "bf16",
                    "voiceCount": loadedVoices.count,
                    "modelSource": source,
                ]
            )
        }
    }

    private func finishPreparation(failure: NativeKokoroFailure) {
        state = .idle
        tts = nil
        voices.removeAll()
        let requestIDs = waitingPrepareIDs
        waitingPrepareIDs.removeAll()
        for requestID in requestIDs {
            replyFailure(
                requestID: requestID,
                code: failure.code,
                message: failure.message,
                retryable: failure.retryable
            )
        }
    }

    /// Preparation is app-scoped and safe to restart from its verified files.
    /// Inactivity is therefore a pause, not a user-visible failure. Retaining
    /// the waiter IDs also means their existing bridge promises settle normally
    /// after UIKit confirms that Metal work may resume.
    private func deferPreparationUntilForeground() {
        guard !waitingPrepareIDs.isEmpty else {
            state = .idle
            return
        }
        guard state != .waitingForForeground else { return }

        state = .waitingForForeground
        print("[Aloud] Native Kokoro preparation deferred until app is active")
        emitProgress(
            stage: "waiting-for-foreground",
            message: "Kokoro will continue when Aloud is active…",
            progress: 1
        )
    }

    private static func configureMLXMemory() {
        Memory.memoryLimit = mlxMemoryLimitBytes
        Memory.cacheLimit = mlxCacheLimitBytes
    }

    // MARK: - Resources and integrity

    private func bundledResource(name: String, extension ext: String) -> URL? {
        let fm = FileManager.default
        let probes: [URL?] = [
            Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "NativeKokoroAssets"),
            Bundle.main.url(forResource: name, withExtension: ext),
            Bundle.main.resourceURL?.appendingPathComponent("NativeKokoroAssets/\(name).\(ext)"),
            Bundle.main.resourceURL?.appendingPathComponent("\(name).\(ext)"),
        ]
        for probe in probes.compactMap({ $0 }) where fm.fileExists(atPath: probe.path) {
            return probe
        }
        if let resources = Bundle.main.resourceURL,
           let entries = try? fm.contentsOfDirectory(at: resources, includingPropertiesForKeys: nil) {
            for entry in entries where entry.pathExtension == "bundle" {
                let candidates = [
                    entry.appendingPathComponent("NativeKokoroAssets/\(name).\(ext)"),
                    entry.appendingPathComponent("\(name).\(ext)"),
                ]
                if let candidate = candidates.first(where: { fm.fileExists(atPath: $0.path) }) {
                    return candidate
                }
            }
        }
        return nil
    }

    private func hashModel(at url: URL, progressStart: Int, progressEnd: Int) throws -> String {
        emitProgress(stage: "verifying-model", message: "Verifying the Kokoro model…", progress: progressStart)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var read: Int64 = 0
        while let data = try handle.read(upToCount: 4 * 1_024 * 1_024), !data.isEmpty {
            hasher.update(data: data)
            read += Int64(data.count)
            let fraction = min(1, Double(read) / Double(Self.expectedModelBytes))
            let progress = progressStart + Int(Double(progressEnd - progressStart) * fraction)
            emitProgress(
                stage: "verifying-model",
                message: "Verifying the Kokoro model…",
                progress: progress,
                loaded: read,
                total: Self.expectedModelBytes
            )
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func hashFile(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 4 * 1_024 * 1_024), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func fileSize(_ url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values?.fileSize ?? 0)
    }

    private static func availableDiskCapacity(at url: URL) -> Int64 {
        if let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let capacity = values.volumeAvailableCapacityForImportantUsage {
            return capacity
        }
        return Int64.max
    }

    // MARK: - Timestamp and WAV helpers

    private static func timestampShift(tokens: [MToken], measuredLead: Double) -> Double {
        guard let first = tokens.first(where: {
            guard let phonemes = $0.phonemes, !phonemes.isEmpty else { return false }
            return $0.start_ts?.isFinite == true
        }), let predicted = first.start_ts else { return 0 }
        // TimestampPredictor deliberately subtracts three duration frames at
        // the head. Calibrate that global offset against this clip's measured
        // first energy without touching its model-derived relative timings.
        return max(-0.15, min(0.15, measuredLead - predicted))
    }

    private static func tokenPayload(_ token: MToken, shift: Double, duration: Double) -> [String: Any] {
        var payload: [String: Any] = [
            "text": token.text,
            "whitespace": token.whitespace,
            "phonemes": token.phonemes ?? "",
        ]
        if let start = token.start_ts, start.isFinite {
            payload["startSec"] = max(0, min(duration, start + shift))
        }
        if let end = token.end_ts, end.isFinite {
            payload["endSec"] = max(0, min(duration, end + shift))
        }
        return payload
    }

    private static func leadingSilence(in samples: [Float]) -> Double {
        let frame = max(1, Int(Double(sampleRate) * 0.02))
        let frameCount = samples.count / frame
        guard frameCount >= 2 else { return 0 }
        var rms = [Float](repeating: 0, count: frameCount)
        var peak: Float = 0
        for index in 0..<frameCount {
            var sum: Float = 0
            let start = index * frame
            for sample in samples[start..<(start + frame)] { sum += sample * sample }
            rms[index] = sqrt(sum / Float(frame))
            peak = max(peak, rms[index])
        }
        let threshold = max(Float(0.00001), peak * 0.012)
        var lead = 0
        while lead < frameCount, rms[lead] < threshold { lead += 1 }
        return Double(lead) * 0.02
    }

    private static func writePCM16WAV(samples: [Float], to finalURL: URL) throws {
        let temporaryURL = finalURL.appendingPathExtension("partial")
        try? FileManager.default.removeItem(at: temporaryURL)
        guard FileManager.default.createFile(atPath: temporaryURL.path, contents: nil) else {
            throw NativeKokoroFailure(code: "write_failed", message: "The audio cache could not create a clip.", retryable: true)
        }

        do {
            let handle = try FileHandle(forWritingTo: temporaryURL)
            defer { try? handle.close() }
            let dataBytes = samples.count * MemoryLayout<Int16>.size
            try handle.write(contentsOf: wavHeader(dataBytes: dataBytes))

            let blockSize = 16_384
            var offset = 0
            while offset < samples.count {
                let end = min(samples.count, offset + blockSize)
                var pcm = [Int16]()
                pcm.reserveCapacity(end - offset)
                for sample in samples[offset..<end] {
                    let finite = sample.isFinite ? sample : 0
                    let clipped = max(-1, min(1, finite))
                    let scaled = clipped < 0 ? clipped * 32_768 : clipped * 32_767
                    pcm.append(Int16(scaled.rounded()))
                }
                let data = pcm.withUnsafeBytes { Data($0) }
                try handle.write(contentsOf: data)
                offset = end
            }
            try handle.synchronize()
            try? FileManager.default.removeItem(at: finalURL)
            try FileManager.default.moveItem(at: temporaryURL, to: finalURL)
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: finalURL.path
            )
        } catch {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw error
        }
    }

    private static func wavHeader(dataBytes: Int) -> Data {
        var data = Data()
        data.append(Data("RIFF".utf8))
        append(UInt32(36 + dataBytes), to: &data)
        data.append(Data("WAVEfmt ".utf8))
        append(UInt32(16), to: &data)
        append(UInt16(1), to: &data)
        append(UInt16(1), to: &data)
        append(UInt32(sampleRate), to: &data)
        append(UInt32(sampleRate * 2), to: &data)
        append(UInt16(2), to: &data)
        append(UInt16(16), to: &data)
        data.append(Data("data".utf8))
        append(UInt32(dataBytes), to: &data)
        return data
    }

    private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    // MARK: - Event and cache helpers

    @discardableResult
    private func replySuccess(requestID: String, result: [String: Any]) -> Bool {
        guard !consumeCancellation(requestID) else { return false }
        emitEvent(["type": "kokoroReply", "requestId": requestID, "ok": true, "result": result])
        return true
    }

    private func replyFailure(requestID: String, code: String, message: String, retryable: Bool) {
        guard !consumeCancellation(requestID) else { return }
        emitEvent([
            "type": "kokoroReply",
            "requestId": requestID,
            "ok": false,
            "error": ["code": code, "message": message, "retryable": retryable],
        ])
    }

    /// A generation must relinquish native admission before its terminal reply
    /// can make JavaScript request the next chunk. Both the optional idle health
    /// event and the reply use `lifecycleEventQueue`, preventing an old idle
    /// report from overtaking a newly admitted request.
    @discardableResult
    private func replyGenerationSuccess(requestID: String, result: [String: Any]) -> Bool {
        releaseGenerationReservation(requestID: requestID)
        var delivered = false
        lifecycleEventQueue.sync {
            delivered = replySuccess(requestID: requestID, result: result)
        }
        return delivered
    }

    private func replyGenerationFailure(
        requestID: String,
        code: String,
        message: String,
        retryable: Bool
    ) {
        releaseGenerationReservation(requestID: requestID)
        lifecycleEventQueue.sync {
            replyFailure(
                requestID: requestID,
                code: code,
                message: message,
                retryable: retryable
            )
        }
    }

    private func emitProgress(
        stage: String,
        message: String,
        progress: Int,
        loaded: Int64? = nil,
        total: Int64? = nil
    ) {
        var event: [String: Any] = [
            "type": "kokoroProgress",
            "stage": stage,
            "message": message,
            "progress": max(0, min(100, progress)),
        ]
        if let loaded { event["loaded"] = loaded }
        if let total { event["total"] = total }
        emitEvent(event)
    }

    private func emitEvent(_ event: [String: Any]) {
        eventLock.lock()
        let handlers = Array(eventHandlers.values)
        eventLock.unlock()
        for handler in handlers { handler(event) }
    }

    /// Tests and removes in one critical section so every cancelled request has
    /// exactly one terminal consumer and the tombstone set cannot grow forever.
    private func consumeCancellation(_ requestID: String) -> Bool {
        cancellationLock.lock()
        defer { cancellationLock.unlock() }
        return cancelledRequestIDs.remove(requestID) != nil
    }

    /// Read-only counterpart used by checkpoints inside the vendored pipeline.
    /// It deliberately leaves the tombstone for the generation's catch path.
    private func isCancellationPending(_ requestID: String) -> Bool {
        cancellationLock.lock()
        defer { cancellationLock.unlock() }
        return cancelledRequestIDs.contains(requestID)
    }

    private func clearCancellation(_ requestID: String) {
        cancellationLock.lock()
        cancelledRequestIDs.remove(requestID)
        cancellationLock.unlock()
    }

    private var isAppActive: Bool {
        activityLock.lock()
        defer { activityLock.unlock() }
        return appActive
    }

    /// Atomically reserves native generation before `generate()` can enqueue
    /// work. A second request is rejected while the first owns MLX, but the
    /// current request is allowed to finish naturally; normal full-quality
    /// inference can legitimately take several seconds on device.
    private func reserveGeneration(requestID: String) -> Bool {
        healthLock.lock()
        if let reservation = generationReservation {
            let busySeconds = max(0, Int(Date().timeIntervalSince(reservation.admittedAt)))
            reportIdleWhenGenerationFinishes = true
            let suffix = busySeconds > 0 ? " for \(busySeconds)s" : ""
            // Enqueue while holding healthLock. The owner must acquire the same
            // lock before it can enqueue idle, preserving busy rejection -> idle
            // order without invoking an event handler inside the lock.
            lifecycleEventQueue.async { [weak self] in
                self?.replyFailure(
                    requestID: requestID,
                    code: "native_busy",
                    message: "Kokoro is finishing earlier speech on this iPad\(suffix).",
                    retryable: true
                )
            }
            healthLock.unlock()
            return false
        }

        generationReservation = GenerationReservation(
            requestID: requestID,
            admittedAt: Date()
        )
        healthLock.unlock()
        return true
    }

    /// Lock-only health data for lifecycle logging and the `appActivity` bridge
    /// event. Reading it never waits for the MLX queue, so a value that remains
    /// busy across a foreground transition is useful evidence of a stranded
    /// native inference without adding a new bridge command.
    @discardableResult
    private func publishActivity(_ active: Bool) -> (busy: Bool, busySeconds: Int) {
        healthLock.lock()
        defer { healthLock.unlock() }
        let busySeconds = generationReservation.map {
            max(0, Int(Date().timeIntervalSince($0.admittedAt)))
        } ?? 0
        let busy = generationReservation != nil
        if active && busy {
            reportIdleWhenGenerationFinishes = true
        } else if !active {
            reportIdleWhenGenerationFinishes = false
        }

        // Enqueue while holding healthLock. Owner release uses the same lock
        // before enqueuing `kokoroHealth`, preserving busy -> idle delivery
        // order without ever invoking an event handler under a lock.
        let event: [String: Any] = [
            "type": "appActivity",
            "active": active,
            "kokoroBusy": busy,
            "kokoroBusySeconds": busySeconds,
        ]
        lifecycleEventQueue.async { [weak self] in self?.emitEvent(event) }
        return (busy, busySeconds)
    }

    /// Clears only the matching owner. JavaScript cancellation deliberately does
    /// not call this method: a Metal evaluation that has begun remains admitted
    /// until its queue scope exits at a safe checkpoint or natural completion.
    private func releaseGenerationReservation(requestID: String) {
        healthLock.lock()
        guard generationReservation?.requestID == requestID else {
            healthLock.unlock()
            return
        }
        generationReservation = nil
        let shouldReportIdle = reportIdleWhenGenerationFinishes && isAppActive
        reportIdleWhenGenerationFinishes = false
        if shouldReportIdle {
            let event: [String: Any] = [
                "type": "kokoroHealth",
                "active": true,
                "busy": false,
                "kokoroBusy": false,
                "kokoroBusySeconds": 0,
                "requestId": requestID,
            ]
            lifecycleEventQueue.async { [weak self] in self?.emitEvent(event) }
        }
        healthLock.unlock()
    }

    /// A prior process cannot still be serving these files, but another live
    /// scene can. Delete only genuinely stale clips instead of emptying the
    /// shared directory whenever a coordinator is created.
    private func pruneOldAudioFiles() {
        guard let directory = try? NativeKokoroPaths.audioDirectory(),
              let files = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey]
              )
        else { return }

        let now = Date()
        for file in files where file.pathExtension == "wav" || file.pathExtension == "partial" {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                ?? .distantPast
            let maximumAge: TimeInterval = file.pathExtension == "partial" ? 60 * 60 : 6 * 60 * 60
            if now.timeIntervalSince(modified) > maximumAge {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    private func trimAudioCache(keeping limit: Int) {
        guard let directory = try? NativeKokoroPaths.audioDirectory(),
              let files = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey]
              ) else { return }
        let wavs = files.filter { $0.pathExtension == "wav" }.sorted {
            let left = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let right = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return left > right
        }
        // A reply may still be crossing into a second WebView. Explicit release
        // normally removes clips within milliseconds; only cap older leftovers.
        let safeCutoff = Date().addingTimeInterval(-10 * 60)
        for file in wavs.dropFirst(limit) {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                ?? .distantPast
            if modified < safeCutoff { try? FileManager.default.removeItem(at: file) }
        }
    }
}

private struct NativeKokoroGenerationCancelled: Error {}

private struct NativeKokoroFailure: LocalizedError {
    let code: String
    let message: String
    let retryable: Bool

    var errorDescription: String? { message }
}

/// Streaming, resumable model download. It always requests the pinned
/// Hugging Face revision and appends only when the server confirms byte ranges.
private final class NativeKokoroDownloader: NSObject, URLSessionDataDelegate {
    private let source: URL
    private let destination: URL
    private let expectedBytes: Int64
    private let progress: (Int64, Int64) -> Void
    private let completion: (Result<Void, Error>) -> Void
    private let delegateQueue: OperationQueue
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var handle: FileHandle?
    private var startingBytes: Int64 = 0
    private var receivedBytes: Int64 = 0
    private var responseError: Error?
    private var finished = false
    private var retryFromZeroRequested = false
    private var retriedFromZero = false
    private var lastProgressTime: TimeInterval = 0
    private var lastProgressBytes: Int64 = 0
    private var responseEndExclusive: Int64?

    init(
        source: URL,
        destination: URL,
        expectedBytes: Int64,
        progress: @escaping (Int64, Int64) -> Void,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        self.source = source
        self.destination = destination
        self.expectedBytes = expectedBytes
        self.progress = progress
        self.completion = completion
        let queue = OperationQueue()
        queue.name = "com.westsmith.aloud.kokoro.download"
        queue.maxConcurrentOperationCount = 1
        self.delegateQueue = queue
        super.init()
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.allowsExpensiveNetworkAccess = true
        configuration.allowsConstrainedNetworkAccess = true
        self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }

    func start() {
        let size = ((try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init)) ?? 0
        startingBytes = (size > 0 && size < expectedBytes) ? size : 0
        if startingBytes == 0 { try? FileManager.default.removeItem(at: destination) }
        beginTask()
    }

    private func beginTask() {
        responseError = nil
        retryFromZeroRequested = false
        receivedBytes = startingBytes
        responseEndExclusive = nil
        var request = URLRequest(url: source)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if startingBytes > 0 { request.setValue("bytes=\(startingBytes)-", forHTTPHeaderField: "Range") }
        task = session.dataTask(with: request)
        task?.resume()
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            responseError = NativeKokoroFailure(
                code: "model_download_failed",
                message: "The model server returned a response Aloud could not read.",
                retryable: true
            )
            completionHandler(.cancel)
            return
        }

        if http.statusCode == 416, startingBytes > 0 {
            requestCleanRetry(
                NativeKokoroFailure(
                    code: "model_download_range_failed",
                    message: "The saved model download no longer matched the server.",
                    retryable: true
                )
            )
            completionHandler(.cancel)
            return
        }
        guard http.statusCode == 200 || http.statusCode == 206 else {
            responseError = NativeKokoroFailure(
                code: "model_download_failed",
                message: "The model server returned HTTP \(http.statusCode).",
                retryable: true
            )
            completionHandler(.cancel)
            return
        }

        do {
            if http.statusCode == 206 {
                guard
                    let range = Self.parseContentRange(http.value(forHTTPHeaderField: "Content-Range")),
                    range.start == startingBytes,
                    range.end >= range.start,
                    range.end < expectedBytes,
                    range.total == expectedBytes
                else {
                    requestCleanRetry(
                        NativeKokoroFailure(
                            code: "model_download_range_failed",
                            message: "The model server returned an invalid resume range.",
                            retryable: true
                        )
                    )
                    completionHandler(.cancel)
                    return
                }
                let segmentBytes = range.end - range.start + 1
                guard response.expectedContentLength < 0
                        || response.expectedContentLength == segmentBytes else {
                    requestCleanRetry(
                        NativeKokoroFailure(
                            code: "model_download_range_failed",
                            message: "The model server's resume length did not match its byte range.",
                            retryable: true
                        )
                    )
                    completionHandler(.cancel)
                    return
                }
                responseEndExclusive = range.end + 1

                if startingBytes == 0 {
                    try createEmptyDestination()
                    receivedBytes = 0
                } else {
                    let actualSize = ((try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init)) ?? -1
                    guard actualSize == startingBytes else {
                        requestCleanRetry(
                            NativeKokoroFailure(
                                code: "model_download_range_failed",
                                message: "The saved model download changed before it could resume.",
                                retryable: true
                            )
                        )
                        completionHandler(.cancel)
                        return
                    }
                    handle = try FileHandle(forWritingTo: destination)
                    try handle?.seekToEnd()
                    receivedBytes = startingBytes
                }
            } else {
                guard response.expectedContentLength < 0
                        || response.expectedContentLength == expectedBytes else {
                    requestCleanRetry(
                        NativeKokoroFailure(
                            code: "model_download_size_failed",
                            message: "The model server announced an unexpected download size.",
                            retryable: true
                        )
                    )
                    completionHandler(.cancel)
                    return
                }
                // A server that ignored Range returned 200: restart cleanly,
                // never append a second complete file to the partial one.
                try createEmptyDestination()
                receivedBytes = 0
                startingBytes = 0
            }
            reportProgress(force: true)
            completionHandler(.allow)
        } catch {
            responseError = error
            completionHandler(.cancel)
        }
    }

    private func createEmptyDestination() throws {
        try? handle?.close()
        handle = nil
        try? FileManager.default.removeItem(at: destination)
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw NativeKokoroFailure(
                code: "write_failed",
                message: "The model cache could not create a file.",
                retryable: true
            )
        }
        handle = try FileHandle(forWritingTo: destination)
    }

    private static func parseContentRange(_ header: String?) -> (start: Int64, end: Int64, total: Int64)? {
        guard let header else { return nil }
        let value = header.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.lowercased().hasPrefix("bytes ") else { return nil }
        let remainder = value.dropFirst(6)
        let halves = remainder.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
        guard halves.count == 2, let total = Int64(halves[1]) else { return nil }
        let bounds = halves[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard bounds.count == 2,
              let start = Int64(bounds[0]),
              let end = Int64(bounds[1]) else { return nil }
        return (start, end, total)
    }

    private func requestCleanRetry(_ error: Error) {
        responseError = error
        retryFromZeroRequested = !retriedFromZero
    }

    private func reportProgress(force: Bool = false) {
        let now = Date.timeIntervalSinceReferenceDate
        let enoughTime = now - lastProgressTime >= 0.25
        let enoughBytes = receivedBytes - lastProgressBytes >= 2 * 1_024 * 1_024
        guard force || receivedBytes == expectedBytes || enoughTime || enoughBytes else { return }
        lastProgressTime = now
        lastProgressBytes = receivedBytes
        progress(min(receivedBytes, expectedBytes), expectedBytes)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        do {
            let nextSize = receivedBytes + Int64(data.count)
            let responseLimit = responseEndExclusive ?? expectedBytes
            guard nextSize <= expectedBytes, nextSize <= responseLimit else {
                requestCleanRetry(
                    NativeKokoroFailure(
                        code: "model_download_oversize",
                        message: "The model server sent more data than the pinned model contains.",
                        retryable: true
                    )
                )
                dataTask.cancel()
                return
            }
            guard let handle else {
                throw NativeKokoroFailure(
                    code: "write_failed",
                    message: "The model cache was not ready to receive data.",
                    retryable: true
                )
            }
            try handle.write(contentsOf: data)
            receivedBytes = nextSize
            reportProgress()
        } catch {
            responseError = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        try? handle?.synchronize()
        try? handle?.close()
        handle = nil
        guard !finished else { return }

        if retryFromZeroRequested, !retriedFromZero {
            retriedFromZero = true
            try? FileManager.default.removeItem(at: destination)
            startingBytes = 0
            receivedBytes = 0
            lastProgressBytes = 0
            lastProgressTime = 0
            beginTask()
            return
        }

        finished = true
        self.session.finishTasksAndInvalidate()

        if let failure = responseError ?? error {
            completion(.failure(failure))
            return
        }
        guard receivedBytes == expectedBytes else {
            completion(.failure(NativeKokoroFailure(
                code: "model_download_incomplete",
                message: "The model download ended before every byte arrived.",
                retryable: true
            )))
            return
        }
        reportProgress(force: true)
        completion(.success(()))
    }
}
