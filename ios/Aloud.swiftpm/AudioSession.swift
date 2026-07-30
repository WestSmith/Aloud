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
    var onNextTrack: (() -> Void)?
    var onPreviousTrack: (() -> Void)?

    private var configured = false

    func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true, options: [])
        } catch {
            // Non-fatal: audio may still work, it just won't survive the mute
            // switch or a screen lock. Worth surfacing in the console rather
            // than dying, since the reader itself is still perfectly usable.
            print("[Aloud] AVAudioSession setup failed: \(error)")
        }

        guard !configured else { return }
        configured = true

        registerRemoteCommands()
        observeInterruptions()
    }

    /// Re-assert the session after an interruption (call, Siri, another app).
    /// iOS deactivates us on interruption and does not always restore cleanly.
    func reactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(true, options: [])
        } catch {
            print("[Aloud] AVAudioSession reactivate failed: \(error)")
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
            // The web app tracks its own playing state; a single toggle message
            // keeps the two sides from disagreeing about who is authoritative.
            guard let onPlay = self?.onPlay else { return .commandFailed }
            onPlay()
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

    private func observeInterruptions() {
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
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
}
