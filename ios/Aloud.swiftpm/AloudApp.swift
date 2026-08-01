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
                .preferredColorScheme(.dark)
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
            if active {
                AudioSession.shared.reactivate()
            }
        }
    }
}

/// Owns launch order: audio session first, then the local server, then the URL
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

    private let server: LocalWebServer?
    private let startupFailure: String?
    private var started = false

    init() {
        guard let webRoot = Self.bundledWebRoot() else {
            server = nil
            startupFailure = "The bundled Aloud reader is missing from this app build. Reinstall this version of Aloud."
            return
        }
        do {
            let audioRoot = try NativeKokoroPaths.audioDirectory()
            server = LocalWebServer(root: webRoot, nativeAudioRoot: audioRoot)
            startupFailure = nil
        } catch {
            server = nil
            startupFailure = "Aloud could not create its private Kokoro audio cache. Check that the iPad has free storage, then reopen the app.\n\n\(error.localizedDescription)"
        }
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

        // Before anything loads: claim a .playback session so the very first
        // sound the web view makes is already exempt from the silent switch.
        AudioSession.shared.activate()

        guard let server else {
            state = .failed(startupFailure ?? "Aloud could not start its bundled reader.")
            return
        }

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
