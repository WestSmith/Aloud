import AVFoundation

/// The Apple-voice engine alongside Web Speech and native Kokoro. It is a fast,
/// model-free alternative, not Kokoro's fallback implementation.
///
/// What it buys over Web Speech, which nominally reaches the same iOS voices:
///
///  • It can use the *Premium* and *Enhanced* voices the user has downloaded in
///    Settings ▸ Accessibility ▸ Spoken Content ▸ Voices. Safari's
///    `speechSynthesis` only ever exposes the compact system set.
///  • `willSpeakRangeOfSpeechString` is a real, reliable word-boundary callback.
///    Aloud's Web Speech path has an entire estimated-timing fallback
///    (`buildTimeline` + `calibFactor`) that exists because iOS voices fire
///    boundary events erratically through the web API. Here they just work, so
///    the karaoke highlight is exact with no calibration at all.
///  • It is instant and free, so it works on a device that cannot hold the full
///    Kokoro model.
///
/// Kokoro still sounds better. This is the option for "I want to start reading
/// right now" and for when the model will not fit.
final class NativeSpeechEngine: NSObject, AVSpeechSynthesizerDelegate {

    /// Emits JSON-ready events back to the web app.
    var onEvent: (([String: Any]) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()

    /// Tokens belong to utterance objects, not to the synthesizer as a whole.
    /// A cancellation callback from an outgoing utterance can arrive after its
    /// replacement is queued; a single mutable "current token" would then stamp
    /// the old callback as new and could advance the reader unexpectedly.
    private var tokens: [ObjectIdentifier: Int] = [:]

    override init() {
        super.init()
        synthesizer.delegate = self

        if #available(iOS 17.0, *) {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(availableVoicesDidChange),
                name: AVSpeechSynthesizer.availableVoicesDidChangeNotification,
                object: nil
            )
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Commands from the web app

    func speak(token: Int, text: String, rate: Double, voiceIdentifier: String?, pitch: Double = 1.0) {
        // Stop BEFORE adopting the new token, so any didCancel/didFinish still
        // in flight for the outgoing utterance is stamped with the old token and
        // gets filtered out on the JS side. Adopting the token first would let a
        // stale completion masquerade as this sentence finishing, and the reader
        // would skip a sentence.
        //
        // `.immediate` — a queued stop would let the outgoing sentence run to its
        // end, audible as a stutter when the user scrubs or changes speed.
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = Self.avRate(forMultiplier: rate)
        utterance.pitchMultiplier = Float(max(0.5, min(2.0, pitch)))
        utterance.postUtteranceDelay = 0

        if let voiceIdentifier, let voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) {
            utterance.voice = voice
        } else {
            utterance.voice = Self.bestDefaultVoice()
        }

        tokens[ObjectIdentifier(utterance)] = token
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func pause() {
        guard synthesizer.isSpeaking, !synthesizer.isPaused else { return }
        // `.word` finishes the word in progress rather than clipping it mid-
        // syllable, which is what a human would expect from a pause button.
        synthesizer.pauseSpeaking(at: .word)
    }

    func resume() {
        guard synthesizer.isPaused else { return }
        synthesizer.continueSpeaking()
    }

    /// Every selectable installed voice, richest first, for the voice picker.
    /// Personal Voice requires a separate, explicit authorization flow, so it
    /// is intentionally omitted instead of advertising an unavailable choice.
    func availableVoices() -> [[String: Any]] {
        let preferred = AVSpeechSynthesisVoice.currentLanguageCode()
        let systemDefaultIdentifier = AVSpeechSynthesisVoice(language: preferred)?.identifier

        return AVSpeechSynthesisVoice.speechVoices()
            .filter { !Self.isPersonalVoice($0) }
            .map { voice -> [String: Any] in
                let quality: String
                switch voice.quality {
                case .premium:  quality = "premium"
                case .enhanced: quality = "enhanced"
                default:        quality = "default"
                }
                return [
                    "id": voice.identifier,
                    "name": voice.name,
                    "lang": voice.language,
                    "quality": quality,
                    "gender": Self.genderLabel(voice),
                    "systemDefault": voice.identifier == systemDefaultIdentifier,
                    "novelty": Self.isNoveltyVoice(voice),
                ]
            }
            .sorted { lhs, rhs in
                // English first, then premium ▸ enhanced ▸ compact, then name.
                let lhsEnglish = (lhs["lang"] as? String)?.hasPrefix("en") == true
                let rhsEnglish = (rhs["lang"] as? String)?.hasPrefix("en") == true
                if lhsEnglish != rhsEnglish { return lhsEnglish }

                let rank = ["premium": 0, "enhanced": 1, "default": 2]
                let lhsRank = rank[lhs["quality"] as? String ?? "default"] ?? 2
                let rhsRank = rank[rhs["quality"] as? String ?? "default"] ?? 2
                if lhsRank != rhsRank { return lhsRank < rhsRank }

                return (lhs["name"] as? String ?? "") < (rhs["name"] as? String ?? "")
            }
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        guard let token = tokens[ObjectIdentifier(utterance)] else { return }
        // NSRange is UTF-16, which is exactly what JavaScript string indices are,
        // so charIndex needs no conversion to line up with the offsets the web
        // app computed when it built this sentence.
        onEvent?([
            "type": "boundary",
            "token": token,
            "charIndex": characterRange.location,
            "length": characterRange.length,
        ])
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard let token = tokens[ObjectIdentifier(utterance)] else { return }
        onEvent?(["type": "start", "token": token])
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard let token = tokens.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
        onEvent?(["type": "end", "token": token])
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard let token = tokens.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
        onEvent?(["type": "cancel", "token": token])
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
        guard let token = tokens[ObjectIdentifier(utterance)] else { return }
        onEvent?(["type": "paused", "token": token])
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
        guard let token = tokens[ObjectIdentifier(utterance)] else { return }
        onEvent?(["type": "resumed", "token": token])
    }

    // MARK: - Helpers

    /// Aloud speaks in multiples of natural speed (1×–4×). AVSpeechUtterance
    /// wants 0…1 with `AVSpeechUtteranceDefaultSpeechRate` (0.5) as natural, and the
    /// scale above default is not linear in perceived speed. This piecewise map
    /// is approximate by design — unlike the Web Speech path, the highlight here
    /// follows real boundary callbacks, so a small speed error costs nothing in
    /// sync accuracy.
    static func avRate(forMultiplier multiplier: Double) -> Float {
        // Note the name: the default is AVSpeechUtteranceDefault*Speech*Rate,
        // while the bounds are AVSpeechUtteranceMinimum/MaximumSpeechRate. The
        // obvious-looking AVSpeechUtteranceDefaultRate does not exist.
        let defaultRate = Double(AVSpeechUtteranceDefaultSpeechRate)
        let m = max(0.5, min(4.0, multiplier))
        let raw: Double
        if m <= 1.0 {
            // 0.5× → 0.25, 1× → 0.5
            raw = defaultRate * m
        } else {
            // 1× → 0.5, 4× → 1.0
            raw = defaultRate + (m - 1.0) * (0.5 / 3.0)
        }
        return Float(max(Double(AVSpeechUtteranceMinimumSpeechRate),
                         min(Double(AVSpeechUtteranceMaximumSpeechRate), raw)))
    }

    /// Prefer a premium/enhanced voice in the user's language over the compact
    /// default, which is the one that makes iOS TTS sound dated.
    private static func bestDefaultVoice() -> AVSpeechSynthesisVoice? {
        let preferred = AVSpeechSynthesisVoice.currentLanguageCode()
        let systemDefault = AVSpeechSynthesisVoice(language: preferred).flatMap { voice in
            isPersonalVoice(voice) || isNoveltyVoice(voice) ? nil : voice
        }
        let voices = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language == preferred && !isPersonalVoice($0) && !isNoveltyVoice($0)
        }
        return voices.first { $0.quality == .premium }
            ?? voices.first { $0.quality == .enhanced }
            ?? systemDefault
            ?? voices.first
    }

    private static func genderLabel(_ voice: AVSpeechSynthesisVoice) -> String {
        switch voice.gender {
        case .male:   return "male"
        case .female: return "female"
        default:      return "unspecified"
        }
    }

    private static func isPersonalVoice(_ voice: AVSpeechSynthesisVoice) -> Bool {
        if #available(iOS 17.0, *) {
            return voice.voiceTraits.contains(.isPersonalVoice)
        }
        return false
    }

    private static func isNoveltyVoice(_ voice: AVSpeechSynthesisVoice) -> Bool {
        if #available(iOS 17.0, *) {
            return voice.voiceTraits.contains(.isNoveltyVoice)
        }
        return false
    }

    @available(iOS 17.0, *)
    @objc private func availableVoicesDidChange() {
        onEvent?(["type": "voices", "voices": availableVoices()])
    }
}
