import Foundation
import Network

/// A minimal static file server bound to loopback, serving the bundled copy of
/// the Aloud web app.
///
/// Why not just `webView.loadFileURL(...)`? Because a `file://` origin in
/// WKWebView has no IndexedDB, no Cache Storage and no service worker. Aloud
/// leans on all three: the Continue library lives in IndexedDB, and
/// transformers.js caches the ~305 MB Kokoro weights in Cache Storage. Loading
/// from `file://` would silently reduce the app to a stateless reader that
/// re-downloads the model on every launch.
///
/// `http://127.0.0.1:<port>/` is a *potentially trustworthy* origin per the W3C
/// secure-context rules, so the page gets the full storage API surface, exactly
/// as it does on GitHub Pages. Nothing is reachable off-device: the listener is
/// pinned to the loopback interface.
final class LocalWebServer {

    /// Ports tried in order. Loopback binds essentially never collide inside an
    /// iOS sandbox, but a range costs nothing and removes a whole failure class.
    private static let candidatePorts: [UInt16] = Array(49_200...49_215)

    private let root: URL
    private let queue = DispatchQueue(label: "com.westsmith.aloud.webserver")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    private(set) var baseURL: URL?

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    // MARK: - Lifecycle

    /// Starts the server, calling back on the main queue with the base URL, or
    /// `nil` if every candidate port failed to bind.
    func start(completion: @escaping (URL?) -> Void) {
        attemptStart(portIndex: 0, completion: completion)
    }

    private func attemptStart(portIndex: Int, completion: @escaping (URL?) -> Void) {
        guard portIndex < Self.candidatePorts.count else {
            DispatchQueue.main.async { completion(nil) }
            return
        }

        let portNumber = Self.candidatePorts[portIndex]
        guard let port = NWEndpoint.Port(rawValue: portNumber) else {
            attemptStart(portIndex: portIndex + 1, completion: completion)
            return
        }

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // Pin to loopback. Without this the listener would accept connections
        // from the local network too, which this app has no business doing.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: port)

        let newListener: NWListener
        do {
            newListener = try NWListener(using: params)
        } catch {
            attemptStart(portIndex: portIndex + 1, completion: completion)
            return
        }

        // Guard against the handler firing more than once (.ready then .failed).
        var settled = false

        newListener.stateUpdateHandler = { [weak self] state in
            guard let self, !settled else { return }
            switch state {
            case .ready:
                settled = true
                let url = URL(string: "http://127.0.0.1:\(portNumber)/")!
                self.baseURL = url
                DispatchQueue.main.async { completion(url) }
            case .failed, .cancelled:
                settled = true
                newListener.cancel()
                self.attemptStart(portIndex: portIndex + 1, completion: completion)
            default:
                break
            }
        }

        newListener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }

        listener = newListener
        newListener.start(queue: queue)
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
    }

    // MARK: - Connection handling

    private func accept(_ connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        queue.async { self.connections[key] = connection }

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.queue.async { self?.connections.removeValue(forKey: key) }
            default:
                break
            }
        }

        connection.start(queue: queue)
        receiveRequest(on: connection, buffer: Data())
    }

    /// Reads until the end of the request head. Bodies are ignored — this server
    /// only ever answers GET and HEAD.
    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] chunk, _, isComplete, error in
            guard let self else { return }

            if error != nil {
                connection.cancel()
                return
            }

            var accumulated = buffer
            if let chunk { accumulated.append(chunk) }

            let terminator = Data("\r\n\r\n".utf8)
            if let headEnd = accumulated.range(of: terminator) {
                let head = accumulated[accumulated.startIndex..<headEnd.lowerBound]
                self.respond(to: head, on: connection)
                return
            }

            if isComplete {
                connection.cancel()
                return
            }

            // A request head this large is not something Aloud ever sends.
            guard accumulated.count < 64 * 1024 else {
                self.send(status: "431 Request Header Fields Too Large", body: Data(), contentType: "text/plain", on: connection)
                return
            }

            self.receiveRequest(on: connection, buffer: accumulated)
        }
    }

    private func respond(to head: Data, on connection: NWConnection) {
        guard
            let headText = String(data: head, encoding: .utf8),
            // components(separatedBy:) rather than split(separator:) — splitting
            // a String on a multi-character String separator depends on a
            // stdlib overload that has moved between Swift versions, and this
            // is not worth a compile error.
            let requestLine = headText.components(separatedBy: "\r\n").first
        else {
            send(status: "400 Bad Request", body: Data(), contentType: "text/plain", on: connection)
            return
        }

        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            send(status: "400 Bad Request", body: Data(), contentType: "text/plain", on: connection)
            return
        }

        let method = String(parts[0]).uppercased()
        guard method == "GET" || method == "HEAD" else {
            send(status: "405 Method Not Allowed", body: Data(), contentType: "text/plain", on: connection)
            return
        }

        guard let fileURL = resolve(target: String(parts[1])) else {
            send(status: "404 Not Found", body: Data("Not found".utf8), contentType: "text/plain", on: connection)
            return
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            send(status: "404 Not Found", body: Data("Not found".utf8), contentType: "text/plain", on: connection)
            return
        }

        send(
            status: "200 OK",
            body: method == "HEAD" ? Data() : data,
            contentType: Self.mimeType(for: fileURL.pathExtension),
            declaredLength: data.count,
            on: connection
        )
    }

    /// Maps a request target onto a file inside `root`, refusing anything that
    /// escapes it. Path traversal on a loopback-only server is a small risk, but
    /// `..` handling is exactly the kind of thing that should never be left to
    /// chance.
    private func resolve(target: String) -> URL? {
        // Strip query and fragment — `?reset` is a real Aloud URL.
        var path = target
        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            path = String(path[path.startIndex..<cut])
        }
        guard let decoded = path.removingPercentEncoding else { return nil }

        var relative = decoded
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }

        let candidate = root.appendingPathComponent(relative).standardizedFileURL

        // standardizedFileURL resolves `..`, so a prefix check is now meaningful.
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path == root.path || candidate.path.hasPrefix(rootPath) else { return nil }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else { return nil }
        if isDirectory.boolValue {
            let index = candidate.appendingPathComponent("index.html")
            return FileManager.default.fileExists(atPath: index.path) ? index : nil
        }
        return candidate
    }

    private func send(
        status: String,
        body: Data,
        contentType: String,
        declaredLength: Int? = nil,
        on connection: NWConnection
    ) {
        var header = "HTTP/1.1 \(status)\r\n"
        header += "Content-Type: \(contentType)\r\n"
        header += "Content-Length: \(declaredLength ?? body.count)\r\n"
        // The app shell is bundled and versioned with the binary, so a stale
        // cached copy would be a bug, never a saving.
        header += "Cache-Control: no-cache\r\n"
        // Deliberately NOT sending COOP/COEP. They would unlock SharedArrayBuffer
        // (multi-threaded WASM, so a faster Kokoro), but they also make every
        // cross-origin load — jsDelivr's kokoro-js, HuggingFace's weights — fail
        // unless it opts in correctly. That trade is a performance experiment,
        // not something to enable by default. See ios/README.md.
        header += "Connection: close\r\n\r\n"

        var payload = Data(header.utf8)
        payload.append(body)

        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "text/javascript; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg":         return "image/svg+xml"
        case "webp":        return "image/webp"
        case "ico":         return "image/x-icon"
        case "wasm":        return "application/wasm"
        case "txt":         return "text/plain; charset=utf-8"
        case "woff2":       return "font/woff2"
        default:            return "application/octet-stream"
        }
    }
}
