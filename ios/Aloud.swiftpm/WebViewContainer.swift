import SwiftUI
import UIKit
import WebKit

/// Hosts the Aloud web app and wires it to the native audio session and speech
/// engine.
struct WebViewContainer: UIViewRepresentable {

    /// Where to load from. Resolved once at launch by `AppModel`.
    let source: URL
    let onFatalError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(shellOrigin: source, onFatalError: onFatalError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "aloudNative")
        controller.addUserScript(
            WKUserScript(source: BridgeScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let config = WKWebViewConfiguration()
        config.userContentController = controller

        // Aloud generates a sentence *then* calls play(), after the tap that
        // started it. The app can allow that delayed playback explicitly.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.suppressesIncrementalRendering = false

        // Persistent store — the Continue library in IndexedDB must survive
        // relaunches. Native Kokoro's weights live outside WebKit entirely.
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
        coordinator.detach()
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {

        private weak var webView: WKWebView?
        private let speech = NativeSpeechEngine()
        private let kokoro = NativeKokoroEngine.shared
        private let shellOrigin: URL
        private let onFatalError: (String) -> Void
        private var kokoroEventHandlerID: UUID?

        init(shellOrigin: URL, onFatalError: @escaping (String) -> Void) {
            self.shellOrigin = shellOrigin
            self.onFatalError = onFatalError
        }

        func attach(webView: WKWebView) {
            self.webView = webView

            speech.onEvent = { [weak self] event in
                self?.emit(event)
            }
            if kokoroEventHandlerID == nil {
                kokoroEventHandlerID = kokoro.addEventHandler { [weak self] event in
                    self?.emit(event)
                }
            }

            // Lock screen / headphone buttons drive the web app's transport.
            AudioSession.shared.onPlay = { [weak self] in self?.remote("play") }
            AudioSession.shared.onPause = { [weak self] in self?.remote("pause") }
            AudioSession.shared.onTogglePlayPause = { [weak self] in self?.remote("toggle") }
            AudioSession.shared.onNextTrack = { [weak self] in self?.remote("next") }
            AudioSession.shared.onPreviousTrack = { [weak self] in self?.remote("prev") }
        }

        func detach() {
            webView = nil
            if let kokoroEventHandlerID {
                kokoro.removeEventHandler(kokoroEventHandlerID)
                self.kokoroEventHandlerID = nil
            }
            speech.stop()
            AudioSession.shared.onPlay = nil
            AudioSession.shared.onPause = nil
            AudioSession.shared.onTogglePlayPause = nil
            AudioSession.shared.onNextTrack = nil
            AudioSession.shared.onPreviousTrack = nil
        }

        deinit {
            if let kokoroEventHandlerID {
                kokoro.removeEventHandler(kokoroEventHandlerID)
            }
        }

        // MARK: Messages from JavaScript

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard
                message.frameInfo.isMainFrame,
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

            case "clearNowPlaying":
                AudioSession.shared.clearNowPlaying()

            case "kokoroPrepare":
                guard let requestID = body["requestId"] as? String else { return }
                // A bridge message is delivered on the main thread. Refresh
                // from UIKit at the point of use as a defensive backstop for
                // lifecycle transitions racing a user tap.
                kokoro.setAppActive(UIApplication.shared.applicationState == .active)
                kokoro.prepare(requestID: requestID)

            case "kokoroGenerate":
                guard let requestID = body["requestId"] as? String else { return }
                kokoro.setAppActive(UIApplication.shared.applicationState == .active)
                kokoro.generate(
                    requestID: requestID,
                    text: body["text"] as? String ?? "",
                    voiceName: body["voice"] as? String ?? "af_heart"
                )

            case "kokoroCancel":
                if let requestID = body["requestId"] as? String {
                    kokoro.cancel(requestID: requestID)
                }

            case "kokoroRelease":
                if let audioID = body["audioId"] as? String {
                    kokoro.release(audioID: audioID)
                }

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
            let isLoopbackShell = url.scheme == shellOrigin.scheme
                && url.host == shellOrigin.host
                && url.port == shellOrigin.port
            let isAuxiliaryWebContent = url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
            let isAllowedWebContent = isLoopbackShell || isAuxiliaryWebContent
            if navigationAction.navigationType == .linkActivated, !isAllowedWebContent {
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
                return
            }

            // The injected native bridge belongs only to Aloud's bundled
            // loopback shell. Never let a redirect or script replace that
            // main frame with a remote page that would inherit the bridge.
            // Blob/data/about content remains available to sandboxed child
            // frames, but it cannot replace the top-level Aloud document.
            if navigationAction.targetFrame?.isMainFrame != false, !isLoopbackShell {
                decisionHandler(.cancel)
                return
            }

            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // The session is already active from launch; re-assert on each load
            // so a reload after an interruption still gets .playback.
            webProcessReloads = 0
            AudioSession.shared.reactivate()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[Aloud] navigation failed: \(error)")
            reportFatalLoadError(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[Aloud] provisional navigation failed: \(error)")
            reportFatalLoadError(error)
        }

        /// iOS can terminate only WKWebView's WebContent process under memory
        /// pressure. Native Kokoro is outside that process, so one reload is a
        /// safe recovery; a second termination before that reload completes is
        /// a real shell failure. A successful reload resets the allowance.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            print("[Aloud] WebContent process terminated (likely memory pressure)")
            guard webProcessReloads == 0 else {
                onFatalError("The iPad stopped Aloud's reader process twice. Reopen the app to start a clean session.")
                return
            }
            webProcessReloads += 1
            webView.reload()
        }

        private func reportFatalLoadError(_ reason: Error) {
            guard !hasReportedFatalError else { return }
            hasReportedFatalError = true
            onFatalError("Aloud could not load its bundled on-device reader. Close Aloud completely and reopen it.\n\n\(reason.localizedDescription)")
        }

        private var hasReportedFatalError = false
        private var webProcessReloads = 0

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
