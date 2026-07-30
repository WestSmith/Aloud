import SwiftUI

@main
struct AloudApp: App {

    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .task { model.start() }
                .preferredColorScheme(.dark)
                .ignoresSafeArea(.keyboard)
        }
    }
}

/// Owns launch order: audio session first, then the local server, then the URL
/// the web view should load.
@MainActor
final class AppModel: ObservableObject {

    enum LoadState {
        case starting
        /// Serving the bundled copy from loopback — the normal path.
        case local(URL)
        /// Loopback bind failed on every candidate port. Rather than show a dead
        /// screen, fall back to the deployed site so the app still works with a
        /// network connection. Storage and the native engine are unaffected;
        /// only offline launch is lost.
        case remote(URL)
        case failed(String)
    }

    @Published private(set) var state: LoadState = .starting

    private let server: LocalWebServer?
    private var started = false

    /// The deployed build. Note the capital A — the lowercased path 404s.
    private static let fallbackURL = URL(string: "https://westsmith.github.io/Aloud/")!

    init() {
        if let webRoot = Bundle.module.url(forResource: "web", withExtension: nil) {
            server = LocalWebServer(root: webRoot)
        } else {
            server = nil
        }
    }

    func start() {
        guard !started else { return }
        started = true

        // Before anything loads: claim a .playback session so the very first
        // sound the web view makes is already exempt from the silent switch.
        AudioSession.shared.activate()

        guard let server else {
            state = .remote(Self.fallbackURL)
            return
        }

        // The completion already lands on the main queue, but it is a plain
        // non-isolated closure, so hop explicitly rather than relying on that —
        // otherwise mutating this @MainActor state is a data-race diagnostic
        // under strict concurrency.
        server.start { [weak self] url in
            Task { @MainActor in
                guard let self else { return }
                if let url {
                    self.state = .local(url)
                } else {
                    print("[Aloud] loopback server could not bind; falling back to the hosted build")
                    self.state = .remote(Self.fallbackURL)
                }
            }
        }
    }
}
