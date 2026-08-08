import Foundation
import Dispatch
import Darwin

/// A minimal static file server bound to loopback, serving the bundled copy of
/// the Aloud web app.
///
/// Why not just `webView.loadFileURL(...)`? Because a `file://` origin in
/// WKWebView has no IndexedDB, no Cache Storage and no service worker. Aloud
/// leans on all three: the Continue library lives in IndexedDB, and
/// The reader library also uses browser storage for its Continue shelf. Loading
/// from `file://` would silently reduce the app to a stateless reader.
///
/// `http://127.0.0.1:<port>/` is a *potentially trustworthy* origin per the W3C
/// secure-context rules, so the page gets the full storage API surface, exactly
/// as it does on GitHub Pages. Nothing is reachable off-device: the listener is
/// pinned to the loopback interface.
final class LocalWebServer {

    /// Keep only one modest chunk per connection in memory. Native Kokoro WAVs
    /// can be several megabytes, so materialising the whole file here would
    /// briefly duplicate it in both the app and WebKit processes.
    private static let fileChunkSize = 128 * 1_024
    private static let maximumRequestHeadSize = 64 * 1_024
    private static let maximumConcurrentConnections = 64
    // Keep this below IANA's dynamic/private range (49152...65535). WebKit and
    // iPadOS use that range heavily for outgoing sockets, making the previous
    // 49200 origin vulnerable to real-device collisions.
    private static let port: UInt16 = 38_473

    private let root: URL
    private let nativeAudioRoot: URL?
    private let listenerQueue = DispatchQueue(label: "com.westsmith.aloud.webserver.listener")
    private let connectionQueue = DispatchQueue(
        label: "com.westsmith.aloud.webserver.connections",
        qos: .userInitiated,
        attributes: .concurrent
    )
    // These three properties are confined to listenerQueue.
    private var listenerFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var connections: [ObjectIdentifier: ClientSocket] = [:]

    private(set) var baseURL: URL?

    init(root: URL, nativeAudioRoot: URL? = nil) {
        self.root = root.standardizedFileURL
        self.nativeAudioRoot = nativeAudioRoot?.standardizedFileURL
    }

    deinit {
        // Every source created here is resumed before publication, so its
        // cancellation handler is guaranteed to perform the listener close.
        acceptSource?.cancel()
        for connection in connections.values {
            connection.requestShutdown()
        }
    }

    // MARK: - Lifecycle

    /// Starts one loopback-only listener at Aloud's stable private origin.
    /// Keeping the origin fixed preserves the web reader's localStorage and
    /// IndexedDB library across launches and app upgrades.
    func start(completion: @escaping (Result<URL, Error>) -> Void) {
        listenerQueue.async { [weak self] in
            guard let self else { return }

            guard self.acceptSource == nil else {
                let result: Result<URL, Error>
                if let baseURL = self.baseURL {
                    result = .success(baseURL)
                } else {
                    result = .failure(LocalWebServerError.alreadyStarting)
                }
                DispatchQueue.main.async { completion(result) }
                return
            }

            let descriptor: Int32
            do {
                descriptor = try Self.makeListenerSocket()
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
                return
            }

            let source = DispatchSource.makeReadSource(
                fileDescriptor: descriptor,
                queue: self.listenerQueue
            )
            source.setEventHandler { [weak self] in
                self?.acceptPendingConnections(from: descriptor)
            }
            source.setCancelHandler { [weak self] in
                Darwin.close(descriptor)
                guard let self, self.listenerFD == descriptor else { return }
                self.listenerFD = -1
                self.acceptSource = nil
            }

            let url = URL(string: "http://127.0.0.1:\(Self.port)/")!
            self.listenerFD = descriptor
            self.acceptSource = source
            self.baseURL = url
            source.resume()
            print("[Aloud] On-device reader ready at \(url.absoluteString)")

            DispatchQueue.main.async { completion(.success(url)) }
        }
    }

    func stop() {
        listenerQueue.async { [weak self] in
            guard let self else { return }
            self.acceptSource?.cancel()
            self.baseURL = nil

            // shutdown() wakes any blocking recv/send without closing and
            // reusing the descriptor underneath its worker. The worker remains
            // the sole owner responsible for the final close().
            for connection in self.connections.values {
                connection.requestShutdown()
            }
            self.connections.removeAll()
        }
    }

    // MARK: - Connection handling

    private static func makeListenerSocket() throws -> Int32 {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw LocalWebServerError.posix(operation: "create TCP socket", code: errno)
        }

        var ownsDescriptor = true
        defer {
            if ownsDescriptor { Darwin.close(descriptor) }
        }

        var enabled: Int32 = 1
        let optionSize = socklen_t(MemoryLayout<Int32>.size)
        guard Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_REUSEADDR,
            &enabled,
            optionSize
        ) == 0 else {
            throw LocalWebServerError.posix(operation: "enable SO_REUSEADDR", code: errno)
        }
        // SO_REUSEPORT is intentionally not enabled: a second process must not
        // share Aloud's private HTTP origin.
        guard Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &enabled,
            optionSize
        ) == 0 else {
            throw LocalWebServerError.posix(operation: "enable SO_NOSIGPIPE", code: errno)
        }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(port).bigEndian
        guard Darwin.inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) == 1 else {
            throw LocalWebServerError.invalidLoopbackAddress
        }

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            throw LocalWebServerError.posix(
                operation: "bind 127.0.0.1:\(port)",
                code: errno
            )
        }

        guard Darwin.listen(descriptor, SOMAXCONN) == 0 else {
            throw LocalWebServerError.posix(operation: "listen on port \(port)", code: errno)
        }

        let currentFlags = Darwin.fcntl(descriptor, F_GETFL)
        guard currentFlags >= 0 else {
            throw LocalWebServerError.posix(operation: "read listener flags", code: errno)
        }
        guard Darwin.fcntl(descriptor, F_SETFL, currentFlags | O_NONBLOCK) == 0 else {
            throw LocalWebServerError.posix(operation: "make listener nonblocking", code: errno)
        }

        ownsDescriptor = false
        return descriptor
    }

    /// Drains accept() until the nonblocking listener reports no more clients.
    /// This method always runs on listenerQueue.
    private func acceptPendingConnections(from descriptor: Int32) {
        guard descriptor == listenerFD else { return }

        while true {
            var peerAddress = sockaddr_storage()
            var peerLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
            let clientFD = withUnsafeMutablePointer(to: &peerAddress) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.accept(descriptor, $0, &peerLength)
                }
            }

            guard clientFD >= 0 else {
                let code = errno
                if code != EAGAIN && code != EWOULDBLOCK && code != EINTR {
                    let error = LocalWebServerError.posix(operation: "accept connection", code: code)
                    print("[Aloud] \(error.localizedDescription)")
                }
                if code == EINTR { continue }
                return
            }

            guard connections.count < Self.maximumConcurrentConnections else {
                Darwin.close(clientFD)
                continue
            }

            do {
                try Self.configureAcceptedSocket(clientFD)
            } catch {
                print("[Aloud] \(error.localizedDescription)")
                Darwin.close(clientFD)
                continue
            }

            let client = ClientSocket(descriptor: clientFD)
            let key = ObjectIdentifier(client)
            connections[key] = client
            connectionQueue.async { [weak self, client] in
                guard let self else {
                    client.finish()
                    return
                }
                self.handle(client)
                self.listenerQueue.async { [weak self] in
                    self?.connections.removeValue(forKey: key)
                }
            }
        }
    }

    private static func configureAcceptedSocket(_ descriptor: Int32) throws {
        // accept() does not normally inherit O_NONBLOCK on Darwin, but clear it
        // explicitly. Each client has a concurrent worker and blocking I/O is
        // intentional there; an inherited flag could otherwise turn an early
        // recv before WebKit writes into a spurious empty response.
        let currentFlags = Darwin.fcntl(descriptor, F_GETFL)
        guard currentFlags >= 0 else {
            throw LocalWebServerError.posix(operation: "read client flags", code: errno)
        }
        guard Darwin.fcntl(descriptor, F_SETFL, currentFlags & ~O_NONBLOCK) == 0 else {
            throw LocalWebServerError.posix(operation: "make client blocking", code: errno)
        }

        var enabled: Int32 = 1
        guard Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_NOSIGPIPE,
            &enabled,
            socklen_t(MemoryLayout<Int32>.size)
        ) == 0 else {
            throw LocalWebServerError.posix(
                operation: "enable SO_NOSIGPIPE for client",
                code: errno
            )
        }

        // Bound a stalled WebKit request without penalising large WAV writes:
        // each successfully-written chunk gets a fresh timeout window.
        var timeout = timeval(tv_sec: 30, tv_usec: 0)
        let timeoutSize = socklen_t(MemoryLayout<timeval>.size)
        guard Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_RCVTIMEO,
            &timeout,
            timeoutSize
        ) == 0 else {
            throw LocalWebServerError.posix(operation: "set client receive timeout", code: errno)
        }
        guard Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_SNDTIMEO,
            &timeout,
            timeoutSize
        ) == 0 else {
            throw LocalWebServerError.posix(operation: "set client send timeout", code: errno)
        }
    }

    private enum RequestReadResult {
        case head(Data)
        case tooLarge
        case closed
    }

    private func handle(_ connection: ClientSocket) {
        defer { connection.finish() }

        switch receiveRequestHead(on: connection) {
        case .head(let head):
            respond(to: head, on: connection)
        case .tooLarge:
            send(
                status: "431 Request Header Fields Too Large",
                body: Data(),
                contentType: "text/plain",
                on: connection
            )
        case .closed:
            return
        }
    }

    /// Reads only through the end of the request head. Bodies are ignored —
    /// this server answers GET and HEAD only. The hard cap prevents an invalid
    /// local client from growing memory without bound.
    private func receiveRequestHead(on connection: ClientSocket) -> RequestReadResult {
        let terminator = Data("\r\n\r\n".utf8)
        var accumulated = Data()
        accumulated.reserveCapacity(16 * 1_024)
        var buffer = [UInt8](repeating: 0, count: 16 * 1_024)

        while true {
            let maximumBuffered = Self.maximumRequestHeadSize + terminator.count
            let capacity = min(buffer.count, maximumBuffered - accumulated.count)
            guard capacity > 0 else { return .tooLarge }

            let received = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
                guard let baseAddress = rawBuffer.baseAddress else { return -1 }
                return Darwin.recv(connection.descriptor, baseAddress, capacity, 0)
            }

            if received == 0 { return .closed }
            if received < 0 {
                if errno == EINTR { continue }
                return .closed
            }

            accumulated.append(contentsOf: buffer[0..<received])
            if let headEnd = accumulated.range(of: terminator) {
                guard headEnd.lowerBound <= Self.maximumRequestHeadSize else {
                    return .tooLarge
                }
                return .head(Data(accumulated[..<headEnd.lowerBound]))
            }
            if accumulated.count >= maximumBuffered { return .tooLarge }
        }
    }

    private func respond(to head: Data, on connection: ClientSocket) {
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

        guard
            let values = try? fileURL.resourceValues(forKeys: [.fileSizeKey]),
            let fileSize = values.fileSize,
            fileSize >= 0
        else {
            send(status: "404 Not Found", body: Data("Not found".utf8), contentType: "text/plain", on: connection)
            return
        }

        let contentType = Self.mimeType(for: fileURL.pathExtension)
        let cacheControl = isNativeAudio(fileURL) ? "no-store" : "no-cache"

        if method == "HEAD" {
            // HEAD must describe the corresponding GET without opening or
            // reading the body. `send` emits only the header when body is empty.
            send(
                status: "200 OK",
                body: Data(),
                contentType: contentType,
                declaredLength: fileSize,
                cacheControl: cacheControl,
                on: connection
            )
            return
        }

        sendFile(
            at: fileURL,
            byteCount: fileSize,
            contentType: contentType,
            cacheControl: cacheControl,
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

        let selectedRoot: URL
        if relative.hasPrefix("__aloud_kokoro/") {
            guard let nativeAudioRoot else { return nil }
            let fileName = String(relative.dropFirst("__aloud_kokoro/".count))
            guard
                !fileName.contains("/"),
                fileName.lowercased().hasSuffix(".wav"),
                UUID(uuidString: String(fileName.dropLast(4))) != nil
            else { return nil }
            selectedRoot = nativeAudioRoot
            relative = fileName
        } else {
            selectedRoot = root
        }

        let candidate = selectedRoot.appendingPathComponent(relative).standardizedFileURL

        // standardizedFileURL resolves `..`, so a prefix check is now meaningful.
        let rootPath = selectedRoot.path.hasSuffix("/") ? selectedRoot.path : selectedRoot.path + "/"
        guard candidate.path == selectedRoot.path || candidate.path.hasPrefix(rootPath) else { return nil }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else { return nil }
        if isDirectory.boolValue {
            let index = candidate.appendingPathComponent("index.html")
            return FileManager.default.fileExists(atPath: index.path) ? index : nil
        }
        return candidate
    }

    private func isNativeAudio(_ url: URL) -> Bool {
        guard let nativeAudioRoot else { return false }
        let prefix = nativeAudioRoot.path.hasSuffix("/") ? nativeAudioRoot.path : nativeAudioRoot.path + "/"
        return url.path.hasPrefix(prefix)
    }

    private func send(
        status: String,
        body: Data,
        contentType: String,
        declaredLength: Int? = nil,
        cacheControl: String = "no-cache",
        on connection: ClientSocket
    ) {
        let header = responseHeader(
            status: status,
            contentType: contentType,
            contentLength: declaredLength ?? body.count,
            cacheControl: cacheControl
        )
        guard connection.write(header) else { return }
        if !body.isEmpty {
            _ = connection.write(body)
        }
    }

    /// Streams a file after its response header, keeping at most one chunk in
    /// memory and never sending more bytes than the advertised Content-Length.
    /// Files served here are immutable app resources or atomically-published
    /// native WAVs, but bounding by `byteCount` also makes a concurrent change
    /// fail closed instead of corrupting the following HTTP response.
    private func sendFile(
        at fileURL: URL,
        byteCount: Int,
        contentType: String,
        cacheControl: String,
        on connection: ClientSocket
    ) {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: fileURL)
        } catch {
            send(status: "404 Not Found", body: Data("Not found".utf8), contentType: "text/plain", on: connection)
            return
        }
        defer { try? handle.close() }

        let header = responseHeader(
            status: "200 OK",
            contentType: contentType,
            contentLength: byteCount,
            cacheControl: cacheControl
        )
        guard connection.write(header) else { return }

        var remaining = byteCount
        while remaining > 0 {
            let chunk: Data
            do {
                guard
                    let data = try handle.read(upToCount: min(Self.fileChunkSize, remaining)),
                    !data.isEmpty
                else {
                    // The file became shorter after its metadata was read.
                    // Closing early makes WebKit reject the incomplete body.
                    return
                }
                chunk = data
            } catch {
                return
            }

            guard connection.write(chunk) else { return }
            remaining -= chunk.count
        }
    }

    private func responseHeader(
        status: String,
        contentType: String,
        contentLength: Int,
        cacheControl: String
    ) -> Data {
        var header = "HTTP/1.1 \(status)\r\n"
        header += "Content-Type: \(contentType)\r\n"
        header += "Content-Length: \(contentLength)\r\n"
        // The app shell is bundled and versioned with the binary, so a stale
        // cached copy would be a bug, never a saving.
        header += "Cache-Control: \(cacheControl)\r\n"
        // Deliberately NOT sending COOP/COEP. They would unlock SharedArrayBuffer
        // (multi-threaded WASM, so a faster Kokoro), but they also make every
        // cross-origin load — jsDelivr's kokoro-js, HuggingFace's weights — fail
        // unless it opts in correctly. That trade is a performance experiment,
        // not something to enable by default. See ios/README.md.
        header += "Connection: close\r\n\r\n"
        return Data(header.utf8)
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
        case "wav":         return "audio/wav"
        case "txt":         return "text/plain; charset=utf-8"
        case "woff2":       return "font/woff2"
        default:            return "application/octet-stream"
        }
    }
}

private final class ClientSocket {
    let descriptor: Int32

    private let lock = NSLock()
    private var shutdownRequested = false
    private var finished = false

    init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    /// Interrupts blocking I/O but deliberately leaves close() to finish().
    /// That prevents the kernel from reusing the integer descriptor while its
    /// worker still has a reference to this connection.
    func requestShutdown() {
        lock.lock()
        defer { lock.unlock() }
        guard !finished, !shutdownRequested else { return }
        shutdownRequested = true
        Darwin.shutdown(descriptor, SHUT_RDWR)
    }

    func finish() {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        finished = true
        if !shutdownRequested {
            shutdownRequested = true
            Darwin.shutdown(descriptor, SHUT_RDWR)
        }
        Darwin.close(descriptor)
    }

    /// Writes all bytes or fails. SO_NOSIGPIPE on every accepted socket keeps a
    /// WebKit cancellation from terminating the host process during send().
    func write(_ data: Data) -> Bool {
        if data.isEmpty { return true }

        return data.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return true }
            var written = 0
            while written < rawBuffer.count {
                let result = Darwin.send(
                    descriptor,
                    baseAddress.advanced(by: written),
                    rawBuffer.count - written,
                    0
                )
                if result > 0 {
                    written += result
                    continue
                }
                if result < 0, errno == EINTR { continue }
                return false
            }
            return true
        }
    }
}

private enum LocalWebServerError: LocalizedError {
    case alreadyStarting
    case invalidLoopbackAddress
    case posix(operation: String, code: Int32)

    var errorDescription: String? {
        switch self {
        case .alreadyStarting:
            return "The on-device reader is already starting."
        case .invalidLoopbackAddress:
            return "The on-device reader could not create its 127.0.0.1 address."
        case .posix(let operation, let code):
            let systemMessage = String(cString: Darwin.strerror(code))
            if code == EADDRINUSE, operation.hasPrefix("bind") {
                return "The on-device reader could not \(operation): the private port is already in use (errno \(code): \(systemMessage)). Close every copy of Aloud and reopen it."
            }
            return "The on-device reader could not \(operation) (errno \(code): \(systemMessage))."
        }
    }
}
