import SwiftUI
import UIKit
import WebKit

/// Hosts the Aloud web app and wires it to the native audio session and speech
/// engine.
struct WebViewContainer: UIViewRepresentable {

    /// Where to load from. Resolved once at launch by `AppModel`.
    let source: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "aloudNative")
        controller.addUserScript(
            WKUserScript(source: BridgeScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let config = WKWebViewConfiguration()
        config.userContentController = controller

        // The single most important line for Kokoro on iOS. Aloud generates a
        // sentence *then* calls play() — seconds after the tap that started it —
        // so the call no longer traces back to a user gesture and Safari refuses
        // it. index.html works around this with a silent-WAV priming trick
        // (`primeAudioGesture`). Here we can just turn the requirement off.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.suppressesIncrementalRendering = false

        // Persistent store — the Continue library (IndexedDB) and the cached
        // Kokoro weights (Cache Storage) must survive relaunches.
        config.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.07, green: 0.07, blue: 0.10, alpha: 1) // matches theme_color #12121a
        webView.scrollView.backgroundColor = webView.backgroundColor

        if #available(iOS 16.4, *) {
            // Lets Safari's Web Inspector attach over USB. Harmless in release,
            // and the difference between debuggable and not when something in a
            // 5,500-line page misbehaves only on device.
            webView.isInspectable = true
        }

        context.coordinator.attach(webView: webView)
        webView.load(URLRequest(url: source))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "aloudNative")
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {

        private weak var webView: WKWebView?
        private let speech = NativeSpeechEngine()

        func attach(webView: WKWebView) {
            self.webView = webView

            speech.onEvent = { [weak self] event in
                self?.emit(event)
            }

            // Lock screen / headphone buttons drive the web app's transport.
            AudioSession.shared.onPlay = { [weak self] in self?.remote("play") }
            AudioSession.shared.onPause = { [weak self] in self?.remote("pause") }
            AudioSession.shared.onNextTrack = { [weak self] in self?.remote("next") }
            AudioSession.shared.onPreviousTrack = { [weak self] in self?.remote("prev") }
        }

        // MARK: Messages from JavaScript

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard
                let body = message.body as? [String: Any],
                let cmd = body["cmd"] as? String
            else { return }

            switch cmd {
            case "speak":
                let token = body["token"] as? Int ?? 0
                let text = body["text"] as? String ?? ""
                let rate = body["rate"] as? Double ?? 1.0
                let voiceId = body["voiceId"] as? String
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    // Nothing to say — report the end immediately so the reader
                    // advances instead of waiting on a callback that never comes.
                    emit(["type": "end", "token": token])
                    return
                }
                speech.speak(token: token, text: text, rate: rate, voiceIdentifier: voiceId)

            case "stop":
                speech.stop()

            case "pause":
                speech.pause()

            case "resume":
                speech.resume()

            case "listVoices":
                emit(["type": "voices", "voices": speech.availableVoices()])

            case "nowPlaying":
                AudioSession.shared.updateNowPlaying(
                    title: body["title"] as? String ?? "Aloud",
                    progress: body["progress"] as? Double ?? 0,
                    playing: body["playing"] as? Bool ?? false
                )

            default:
                break
            }
        }

        // MARK: Messages to JavaScript

        private func emit(_ event: [String: Any]) {
            guard
                let data = try? JSONSerialization.data(withJSONObject: event, options: []),
                let json = String(data: data, encoding: .utf8)
            else { return }

            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript("window.__aloudNative._emit(\(json));", completionHandler: nil)
            }
        }

        private func remote(_ action: String) {
            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript("window.__aloudNative._remote('\(action)');", completionHandler: nil)
            }
        }

        // MARK: Navigation

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            // Keep the app shell in the web view; send real outbound links —
            // source citations in an article, say — to Safari rather than
            // stranding the user in a chrome-less view with no back button.
            let isAppShell = url.host == "127.0.0.1" || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
            if navigationAction.navigationType == .linkActivated, !isAppShell {
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
                return
            }

            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // The session is already active from launch; re-assert on each load
            // so a reload after an interruption still gets .playback.
            AudioSession.shared.reactivate()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[Aloud] navigation failed: \(error)")
            fallBackToHostedBuild(webView, reason: error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[Aloud] provisional navigation failed: \(error)")
            fallBackToHostedBuild(webView, reason: error)
        }

        /// The loopback server binding is only half the battle — App Transport
        /// Security can still refuse the `http://127.0.0.1` load itself if the
        /// Info.plist additions didn't make it into the built app. That failure
        /// mode is a blank screen with nothing to go on, so treat *any* failure
        /// to load the local origin as a cue to try the hosted build instead.
        /// Once is enough: a second failure means there is no network either,
        /// and retrying forever would just spin.
        private func fallBackToHostedBuild(_ webView: WKWebView, reason: Error) {
            guard !hasFallenBack else { return }
            guard webView.url?.host == "127.0.0.1" || webView.url == nil else { return }
            hasFallenBack = true
            print("[Aloud] local load failed (\(reason.localizedDescription)) — trying the hosted build")
            webView.load(URLRequest(url: Self.hostedFallbackURL))
        }

        private var hasFallenBack = false
        private static let hostedFallbackURL = URL(string: "https://westsmith.github.io/Aloud/")!

        /// `target="_blank"` links have no window to open into inside the app.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url, navigationAction.targetFrame == nil {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }
}
