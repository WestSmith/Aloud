import AVFoundation
import MediaPlayer

/// The reason this app exists.
///
/// In Safari, every sound Aloud makes — the Kokoro `<audio>` element and any
/// Web Speech utterance — is routed through a web page's audio session, which
/// iOS treats as *ambient*. Ambient audio obeys the hardware/Control Centre
/// silent switch, so a muted iPad plays nothing at all: no error, no crash, the
/// karaoke highlight still sweeps across the words in perfect silence. There is
/// no API a web page can call to opt out of that.
///
/// A native app can. `.playback` is the category that means "audio is the point
/// of this app" — it ignores the silent switch and keeps playing when the screen
/// locks. Setting it here fixes the silence for *both* engines at once, Kokoro
/// included, because the WKWebView's audio runs inside this same session.
///
/// `.spokenAudio` is the mode Apple defines for podcasts/audiobooks/TTS. It gets
/// the right interruption behaviour (a phone call pauses rather than ducks) and
/// makes AirPlay and CarPlay treat Aloud as spoken content.
final class AudioSession {

    static let shared = AudioSession()

    private init() {}

    /// Callbacks into whatever is currently producing audio. The web view sets
    /// these so the lock screen and headphone buttons drive the real player.
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onTogglePlayPause: (() -> Void)?
    var onNextTrack: (() -> Void)?
    var onPreviousTrack: (() -> Void)?

    private var configured = false
    private let resetHandlerLock = NSLock()
    private var resetHandlers: [UUID: () -> Void] = [:]

    func activate() {
        configureSession(reason: "initial setup", activate: true, forceConfiguration: true)

        guard !configured else { return }
        configured = true

        registerRemoteCommands()
        observeSessionNotifications()
    }

    /// Re-assert the session after an interruption (call, Siri, another app).
    /// iOS deactivates us on interruption and does not always restore cleanly.
    @discardableResult
    func reactivate() -> Bool {
        configureSession(reason: "reactivation", activate: true)
    }

    @discardableResult
    func addMediaServicesResetHandler(_ handler: @escaping () -> Void) -> UUID {
        let identifier = UUID()
        resetHandlerLock.lock()
        resetHandlers[identifier] = handler
        resetHandlerLock.unlock()
        return identifier
    }

    func removeMediaServicesResetHandler(_ identifier: UUID) {
        resetHandlerLock.lock()
        resetHandlers.removeValue(forKey: identifier)
        resetHandlerLock.unlock()
    }

    /// Category and mode are normally persistent, but a media-services reset
    /// invalidates the audio-session configuration as well as underlying audio
    /// objects. Reapply the complete contract rather than only setting active.
    @discardableResult
    private func configureSession(
        reason: String,
        activate: Bool,
        forceConfiguration: Bool = false
    ) -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            // Avoid needlessly reconfiguring an already-correct active route on
            // every foreground transition. A media-services reset forces this
            // call because its old property values are not a recovery contract.
            if forceConfiguration || session.category != .playback || session.mode != .spokenAudio {
                try session.setCategory(.playback, mode: .spokenAudio, options: [])
            }
            if activate {
                try session.setActive(true, options: [])
            }
            return true
        } catch {
            // Non-fatal: the reader remains usable and a later foreground or
            // interruption callback gets another chance to restore playback.
            print("[Aloud] AVAudioSession \(reason) failed: \(error)")
            return false
        }
    }

    // MARK: - Lock screen / headphone controls

    private func registerRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            guard let onPlay = self?.onPlay else { return .commandFailed }
            onPlay()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let onPause = self?.onPause else { return .commandFailed }
            onPause()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let onTogglePlayPause = self?.onTogglePlayPause else { return .commandFailed }
            onTogglePlayPause()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let next = self?.onNextTrack else { return .commandFailed }
            next()
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let prev = self?.onPreviousTrack else { return .commandFailed }
            prev()
            return .success
        }
    }

    private func observeSessionNotifications() {
        let notifications = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        notifications.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] note in
            guard
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }

            switch type {
            case .began:
                self?.onPause?()
            case .ended:
                self?.reactivate()
            @unknown default:
                break
            }
        }

        notifications.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            print("[Aloud] Audio media services reset; rebuilding playback objects")
            // Apple requires orphaned players to be recreated and playback to
            // remain stopped until the user asks for it again. Restore the
            // category/mode now, notify WebKit to discard its Audio element,
            // and let the next Play command reactivate the session.
            self.configureSession(
                reason: "media-services reset",
                activate: false,
                forceConfiguration: true
            )
            self.resetHandlerLock.lock()
            let handlers = Array(self.resetHandlers.values)
            self.resetHandlerLock.unlock()
            for handler in handlers { handler() }
        }
    }

    /// Populate the lock screen with what is currently being read.
    func updateNowPlaying(title: String, progress: Double, playing: Bool) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: "Aloud",
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
        if progress.isFinite, progress >= 0, progress <= 1 {
            info[MPNowPlayingInfoPropertyPlaybackProgress] = Float(progress)
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Remove a document that is no longer open from the lock screen and
    /// Control Centre without deactivating the app's playback audio session.
    /// The next document can therefore publish metadata and play immediately.
    func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
