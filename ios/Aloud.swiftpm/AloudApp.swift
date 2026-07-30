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
        if let webRoot = Self.bundledWebRoot() {
            server = LocalWebServer(root: webRoot)
        } else {
            print("[Aloud] bundled web/ not found — using the hosted build")
            server = nil
        }
    }

    /// Locate the bundled copy of the web app.
    ///
    /// Not `Bundle.module`: that accessor is synthesised by SwiftPM for library
    /// targets with resources, and Swift Playgrounds' app target does not get
    /// one — referencing it fails to compile with "Type 'Bundle' has no member
    /// 'module'". For an `.iOSApplication` product, `.copy("web")` resources
    /// land in the app bundle itself, so `Bundle.main` is the right root.
    ///
    /// The extra probes cost nothing and cover the layouts different toolchains
    /// produce, since a wrong guess here silently degrades the app to
    /// network-only.
    private static func bundledWebRoot() -> URL? {
        let fm = FileManager.default

        // Normal case: copied straight into the app bundle's resources.
        if let url = Bundle.main.url(forResource: "web", withExtension: nil),
           fm.fileExists(atPath: url.appendingPathComponent("index.html").path) {
            return url
        }

        guard let resources = Bundle.main.resourceURL else { return nil }

        let direct = resources.appendingPathComponent("web")
        if fm.fileExists(atPath: direct.appendingPathComponent("index.html").path) {
            return direct
        }

        // Some toolchains nest package resources inside a generated .bundle.
        if let entries = try? fm.contentsOfDirectory(at: resources, includingPropertiesForKeys: nil) {
            for entry in entries where entry.pathExtension == "bundle" {
                let nested = entry.appendingPathComponent("web")
                if fm.fileExists(atPath: nested.appendingPathComponent("index.html").path) {
                    return nested
                }
            }
        }

        return nil
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
