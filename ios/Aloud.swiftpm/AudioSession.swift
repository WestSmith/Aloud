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

    // Each scene owns its callbacks. An idle/closing window cannot clear the
    // playing window's remote controls or metadata. Access is on the main queue.
    private var owners: [UUID: (String) -> Void] = [:]
    private var metadata: [UUID: [String: Any]] = [:]
    private var playingOwners = Set<UUID>()
    private var activeOwner: UUID?
    private var configured = false
    private var sessionActive = false

    func register(owner: UUID, remote: @escaping (String) -> Void) {
        owners[owner] = remote
        guard !configured else { return }
        configured = true
        let center = MPRemoteCommandCenter.shared()
        for (command, action) in [(center.playCommand, "play"), (center.pauseCommand, "pause"),
                                  (center.togglePlayPauseCommand, "toggle"),
                                  (center.nextTrackCommand, "next"), (center.previousTrackCommand, "prev")] {
            command.addTarget { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, let owner = self.activeOwner else { return }
                    self.owners[owner]?(action)
                }
                return .success
            }
        }
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(), queue: .main
        ) { [weak self] note in
            guard let self,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            self.sessionActive = false
            for owner in self.playingOwners { self.owners[owner]?("pause") }
            // Resume only on an explicit Play; do not take audio back from Siri
            // or another app just because Aloud comes to the foreground.
        }
    }

    /// Called on requested playback, never at launch, setup or foregrounding.
    func acquire(owner: UUID) -> String? {
        do {
            if !sessionActive {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .spokenAudio, options: [])
                try session.setActive(true)
                sessionActive = true
            }
            playingOwners.insert(owner)
            activeOwner = owner
            return nil
        } catch {
            return "Aloud could not activate playback audio: \(error.localizedDescription)"
        }
    }

    func release(owner: UUID) -> String? {
        playingOwners.remove(owner)
        guard playingOwners.isEmpty, sessionActive else { return nil }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            sessionActive = false
            return nil
        } catch {
            return "Aloud could not release playback audio: \(error.localizedDescription)"
        }
    }

    func remove(owner: UUID) {
        _ = release(owner: owner)
        owners.removeValue(forKey: owner)
        metadata.removeValue(forKey: owner)
        if activeOwner == owner {
            activeOwner = playingOwners.first ?? metadata.keys.first
            MPNowPlayingInfoCenter.default().nowPlayingInfo = activeOwner.flatMap { metadata[$0] }
        }
    }

    func updateNowPlaying(owner: UUID, title: String, progress: Double, playing: Bool) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: "Aloud",
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
        if progress.isFinite, progress >= 0, progress <= 1 {
            info[MPNowPlayingInfoPropertyPlaybackProgress] = Float(progress)
        }
        metadata[owner] = info
        if activeOwner == nil { activeOwner = owner }
        if activeOwner == owner { MPNowPlayingInfoCenter.default().nowPlayingInfo = info }
    }

    func clearNowPlaying(owner: UUID) {
        _ = release(owner: owner)
        metadata.removeValue(forKey: owner)
        if activeOwner == owner {
            activeOwner = playingOwners.first ?? metadata.keys.first
            MPNowPlayingInfoCenter.default().nowPlayingInfo = activeOwner.flatMap { metadata[$0] }
        }
    }
}
