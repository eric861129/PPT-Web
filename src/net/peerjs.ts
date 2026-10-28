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

/**
 * 配對伺服器。預設用免費的 PeerJS Cloud；它對同一個 IP 的新連線數有上限，
 * 觀眾很多時可以自架 PeerJS 伺服器，build 時設 VITE_PEER_SERVER（例如 https://peer.example.com/）。
 */
function peerOptions(): { debug: 1; host?: string; port?: number; path?: string; secure?: boolean } {
  const raw = import.meta.env.VITE_PEER_SERVER as string | undefined
  if (!raw) return { debug: 1 }
  const url = new URL(raw)
  const secure = url.protocol === 'https:'
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return { debug: 1, host: url.hostname, port: Number(url.port) || (secure ? 443 : 80), path, secure }
}

const PEER_OPTIONS = peerOptions()

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
    const current = new Peer(roomId, PEER_OPTIONS)
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
  const peer = new Peer(PEER_OPTIONS)

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

/**
 * 觀眾頁用：整個頁面共用一個 Peer（一條連到配對伺服器的連線），重連時只重新撥號。
 * 台下幾十支手機常常共用同一個 Wi-Fi 對外 IP，如果每次重試都開新的 Peer，
 * 一起重試時就會被配對伺服器擋下來。
 */
function reusingConnector(): (roomId: string) => Promise<Link> {
  let peer: Peer | undefined

  const discard = (current: Peer) => {
    current.destroy()
    if (peer === current) peer = undefined
  }

  const ready = async (): Promise<Peer> => {
    const { Peer } = await loadPeerJs()
    if (!peer || peer.destroyed) peer = new Peer(PEER_OPTIONS)
    else if (peer.open) return peer
    else if (peer.disconnected) peer.reconnect()
    const current = peer
    return new Promise<Peer>((resolve, reject) => {
      const done = (ok: boolean) => {
        clearTimeout(timeout)
        current.off('open', onOpen)
        current.off('error', onError)
        if (ok) return resolve(current)
        discard(current)
        reject(new ConnectError('network'))
      }
      const onOpen = () => done(true)
      const onError = (err: { type: string }) => {
        if (FATAL_ERRORS.has(err.type)) done(false)
      }
      const timeout = setTimeout(() => done(false), CONNECT_TIMEOUT_MS)
      current.on('open', onOpen)
      current.on('error', onError)
    })
  }

  return async (roomId) => {
    const current = await ready()
    return new Promise<Link>((resolve, reject) => {
      let settled = false
      const conn = current.connect(roomId, { reliable: true })
      const finish = (error?: ConnectError) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        current.off('error', onError)
        if (!error) return resolve(new PeerLink(conn))
        conn.close()
        // 找不到對方是正常的（講者還沒開放）；其他失敗就整個重來，避免卡在一條已經死掉的連線上
        if (error.reason !== 'not-found') discard(current)
        reject(error)
      }
      const onError = (err: { type: string; message: string }) => {
        if (err.type === 'peer-unavailable') finish(new ConnectError('not-found'))
        else if (FATAL_ERRORS.has(err.type)) finish(new ConnectError('network'))
      }
      const timeout = setTimeout(() => finish(new ConnectError('timeout')), CONNECT_TIMEOUT_MS)
      current.on('error', onError)
      conn.on('open', () => finish())
    })
  }
}

export const viewerTransport: Transport = { host: startHost, connect: reusingConnector() }
