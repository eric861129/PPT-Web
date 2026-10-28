// 用 PeerJS 實作 Transport：PeerJS Cloud 只負責配對時交換連線資訊，
// 之後的資料走 WebRTC DataChannel 點對點直連。
// PeerJS 等到真的要連線時才載入，沒用到手機遙控就不會連任何外部伺服器。
import type { DataConnection, Peer } from 'peerjs'
import { ConnectError, type Host, type HostEvents, type Link, type Transport } from './transport'

const CONNECT_TIMEOUT_MS = 15000
const MAX_ID_RETRIES = 3

/** 這些錯誤會讓 Peer 無法再用，要整個重建 */
const FATAL_ERRORS = new Set([
  'network',
  'server-error',
  'socket-error',
  'socket-closed',
  'ssl-unavailable',
  'unavailable-id',
])

let peerModule: Promise<typeof import('peerjs')> | undefined
const loadPeerJs = () => (peerModule ??= import('peerjs'))

class PeerLink implements Link {
  onMessage: ((message: unknown) => void) | null = null
  onClose: (() => void) | null = null
  private closed = false

  constructor(
    private readonly conn: DataConnection,
    private readonly onDispose?: () => void,
  ) {
    conn.on('data', (data) => this.onMessage?.(data))
    conn.on('close', () => this.finish())
    conn.on('error', () => this.finish())
  }

  get peer(): string {
    return this.conn.peer
  }

  send(message: unknown): void {
    if (!this.closed && this.conn.open) void this.conn.send(message)
  }

  close(options?: { flush?: boolean }): void {
    this.conn.close(options)
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.onDispose?.()
    this.onClose?.()
  }
}

function startHost(roomId: string, events: HostEvents): Host {
  let peer: Peer | undefined
  let destroyed = false
  let failures = 0
  let idFailures = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const restartLater = () => {
    peer?.destroy()
    peer = undefined
    failures++
    if (failures > 1) events.status('offline')
    timer = setTimeout(start, Math.min(15000, 1000 * 2 ** Math.min(failures, 4)))
  }

  const start = async () => {
    const { Peer } = await loadPeerJs()
    if (destroyed) return
    events.status(failures > 1 ? 'offline' : 'starting')
    const current = new Peer(roomId, { debug: 1 })
    peer = current

    current.on('open', () => {
      failures = 0
      idFailures = 0
      events.status('ready')
    })
    current.on('connection', (conn) => {
      conn.on('open', () => events.link(new PeerLink(conn)))
    })
    // 跟配對伺服器斷線時，已建立的手機連線不受影響；重新連上伺服器才能接受新手機
    current.on('disconnected', () => {
      if (destroyed || current.destroyed || peer !== current) return
      events.status('offline')
      timer = setTimeout(() => {
        if (!current.destroyed) current.reconnect()
      }, 2000)
    })
    current.on('error', (err) => {
      if (destroyed || peer !== current || !FATAL_ERRORS.has(err.type)) return
      if (err.type === 'unavailable-id' && ++idFailures >= MAX_ID_RETRIES) {
        current.destroy()
        peer = undefined
        events.idTaken()
        return
      }
      restartLater()
    })
  }

  void start()
  return {
    destroy() {
      destroyed = true
      clearTimeout(timer)
      peer?.destroy()
    },
  }
}

async function connect(roomId: string): Promise<Link> {
  const { Peer } = await loadPeerJs()
  // 每次連線都用一個新的 Peer，斷線就整個丟掉，重連時重新來過最單純
  const peer = new Peer({ debug: 1 })

  return new Promise<Link>((resolve, reject) => {
    let settled = false
    const fail = (error: ConnectError) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      peer.destroy()
      reject(error)
    }
    const timeout = setTimeout(() => fail(new ConnectError('timeout')), CONNECT_TIMEOUT_MS)

    peer.on('error', (err) => fail(new ConnectError(err.type === 'peer-unavailable' ? 'not-found' : 'network')))
    peer.on('open', () => {
      const conn = peer.connect(roomId, { reliable: true })
      conn.on('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(new PeerLink(conn, () => peer.destroy()))
      })
    })
  })
}

export const peerTransport: Transport = { host: startHost, connect }
