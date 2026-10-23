import SwiftUI
import UIKit

@main
struct AloudApp: App {

    /// Read at the App level, this is the aggregate phase of every Aloud
    /// window: it remains active while any iPad window is interactive.
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .task { model.start() }
                .ignoresSafeArea(.keyboard)
        }
        // UIApplicationDelegate's active/inactive callbacks are not called by
        // UIKit once an app adopts scenes. SwiftUI's App-level scenePhase is
        // the correct multi-window lifecycle source and reports .active when
        // any Aloud scene is active.
        .onChange(of: scenePhase, initial: true) { _, phase in
            let active = phase == .active
            print("[Aloud] Aggregate scene active: \(active)")
            NativeKokoroEngine.shared.setAppActive(active)
        }
    }
}

/// Owns launch order: the local server, then the URL
/// the web view should load.
@MainActor
final class AppModel: ObservableObject {

    enum LoadState {
        case starting
        /// Serving the bundled copy from loopback — the only supported path.
        case local(URL)
        case failed(String)
    }

    @Published private(set) var state: LoadState = .starting

    private var server: LocalWebServer?
    private var started = false

    func retry() {
        started = false
        state = .starting
        start()
    }

    var diagnostics: String {
        let detail: String
        if case .failed(let message) = state { detail = message } else { detail = "Starting reader" }
        return "Aloud native startup • iOS \(UIDevice.current.systemVersion)\n\(detail)"
    }

    /// Locate the bundled copy of the web app.
    ///
    /// Not `Bundle.module`: that accessor is synthesised by SwiftPM for library
    /// targets with resources, and this generated app target does not get
    /// one — referencing it fails to compile with "Type 'Bundle' has no member
    /// 'module'". For an `.iOSApplication` product, `.copy("web")` resources
    /// land in the app bundle itself, so `Bundle.main` is the right root.
    ///
    /// The extra probes cover the layouts produced by different toolchains.
    /// The bundled shell is required because its loopback origin also serves
    /// native Kokoro's temporary audio files.
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

        if server == nil {
            guard let webRoot = Self.bundledWebRoot() else {
                state = .failed("The bundled reader is missing. Reinstall this version of Aloud.")
                return
            }
            do {
                server = LocalWebServer(root: webRoot, nativeAudioRoot: try NativeKokoroPaths.audioDirectory())
            } catch {
                state = .failed("Aloud could not create its private audio cache. Check free storage and retry.\n\n\(error.localizedDescription)")
                return
            }
        }
        guard let server else { return }

        // The completion already lands on the main queue, but it is a plain
        // non-isolated closure, so hop explicitly rather than relying on that —
        // otherwise mutating this @MainActor state is a data-race diagnostic
        // under strict concurrency.
        server.start { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let url):
                    self.state = .local(url)
                case .failure(let error):
                    self.state = .failed(
                        "Aloud could not start its private on-device reader.\n\nTechnical details: \(error.localizedDescription)"
                    )
                }
            }
        }
    }

    func fail(_ message: String) {
        state = .failed(message)
    }
}
