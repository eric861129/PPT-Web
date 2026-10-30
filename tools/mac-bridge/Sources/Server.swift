import Foundation
import Network

/// 只聽這台電腦的 WebSocket 伺服器，握手時檢查 Origin。同一時間只服務一個網頁，
/// 新的網頁連進來（例如重新整理）就換掉舊的。所有回呼都在主執行緒。
final class BridgeServer {
    var onListening: () -> Void = {}
    var onFailure: (String) -> Void = { _ in }
    var onReject: (String) -> Void = { _ in }
    var onConnect: (String) -> Void = { _ in }
    var onDisconnect: () -> Void = {}
    var onMessage: ([String: Any]) -> Void = { _ in }

    let port: UInt16
    private let isAllowed: (String) -> Bool
    private var listener: NWListener?
    private var client: NWConnection?
    /// 最近一次通過檢查的 Origin；握手時還拿不到連線本身，等連線好了再拿來顯示
    private var acceptedOrigin = ""

    init(port: UInt16, isAllowed: @escaping (String) -> Bool) {
        self.port = port
        self.isAllowed = isAllowed
    }

    func start() {
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        websocket.maximumMessageSize = 1 << 20
        websocket.setClientRequestHandler(.main) { [weak self] _, headers in
            let origin = headers.first(where: { $0.name.lowercased() == "origin" })?.value ?? ""
            guard let self = self, self.isAllowed(origin) else {
                self?.onReject(origin)
                return NWProtocolWebSocket.Response(status: .reject, subprotocol: nil, additionalHeaders: nil)
            }
            self.acceptedOrigin = origin
            return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil, additionalHeaders: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        // 只接受這台電腦自己的連線，accept() 會再檢查一次對方的位址
        parameters.requiredInterfaceType = .loopback
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else { return onFailure("連接埠不正確") }
        let listener: NWListener
        do {
            listener = try NWListener(using: parameters, on: endpointPort)
        } catch {
            return onFailure(String(describing: error))
        }
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.onListening()
            case .failed(let error), .waiting(let error):
                self?.onFailure(String(describing: error))
                listener.cancel()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: .main)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        client?.cancel()
    }

    func send(_ message: [String: Any]) {
        guard let client = client, JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "message", metadata: [metadata])
        client.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }

    private func accept(_ connection: NWConnection) {
        guard Self.isLoopback(connection.endpoint) else { return connection.cancel() }
        // 連線在自己的回呼裡留著自己，結束時才放掉
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.adopt(connection)
            case .failed, .waiting:
                connection.cancel()
            case .cancelled:
                connection.stateUpdateHandler = nil
                self?.drop(connection)
            default:
                break
            }
        }
        connection.start(queue: .main)
    }

    private func adopt(_ connection: NWConnection) {
        let previous = client
        client = connection
        if let previous = previous { close(previous) }
        receive(on: connection)
        onConnect(acceptedOrigin)
    }

    private func drop(_ connection: NWConnection) {
        guard client === connection else { return }
        client = nil
        onDisconnect()
    }

    private func close(_ connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
        metadata.closeCode = .protocolCode(.normalClosure)
        let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
        connection.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self = self, self.client === connection else { return }
            if error != nil { return connection.cancel() }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            switch metadata?.opcode {
            case .text?, .binary?:
                if let data = data, let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.onMessage(message)
                }
            case .close?:
                return connection.cancel()
            case nil where data == nil:
                return connection.cancel()
            default:
                break
            }
            self.receive(on: connection)
        }
    }

    private static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address):
            return address.isLoopback
        case .ipv6(let address):
            return address.isLoopback || address.asIPv4?.isLoopback == true
        case .name(let name, _):
            return name == "localhost"
        @unknown default:
            return false
        }
    }
}
