// 連線層的介面。目前用 PeerJS 實作（peerjs.ts），之後要換成 Trystero
// 或自架伺服器，只要另外實作這個介面就好；測試則用假的實作。

export interface Link {
  /** 對方的連線 id，只用來區分不同連線 */
  readonly peer: string
  send(message: unknown): void
  /** flush：先把還在排隊的訊息送完再斷線 */
  close(options?: { flush?: boolean }): void
  onMessage: ((message: unknown) => void) | null
  onClose: (() => void) | null
}

/** starting：正在向配對伺服器註冊；ready：可以接受手機；offline：連不上配對伺服器，持續重試中 */
export type HostStatus = 'starting' | 'ready' | 'offline'

export interface HostEvents {
  status(status: HostStatus): void
  link(link: Link): void
  /** 這個 room id 已經被別人用了（例如複製了分頁），呼叫端應換一個 id */
  idTaken(): void
}

export interface Host {
  destroy(): void
}

export type ConnectFailure = 'not-found' | 'network' | 'timeout'

export class ConnectError extends Error {
  constructor(readonly reason: ConnectFailure) {
    super(reason)
  }
}

export interface Transport {
  host(roomId: string, events: HostEvents): Host
  /** 連到電腦端；失敗時 reject ConnectError */
  connect(roomId: string): Promise<Link>
}
