// 簡報計時器：開始放映時自動開始，可以暫停、繼續、重設。
// 由電腦端持有，所有手機與講者檢視看到的都是同一個時間。

export class Stopwatch {
  /** 暫停前累積的毫秒數 */
  private base = 0
  /** 正在計時時，這一段的開始時間 */
  private since: number | null = null
  private everStarted = false

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** 開始過嗎？還沒開始過時手機顯示現在時間 */
  get started(): boolean {
    return this.everStarted
  }

  get running(): boolean {
    return this.since !== null
  }

  elapsed(): number {
    return this.base + (this.since === null ? 0 : this.now() - this.since)
  }

  start(): void {
    if (this.since !== null) return
    this.since = this.now()
    this.everStarted = true
  }

  pause(): void {
    if (this.since === null) return
    this.base += this.now() - this.since
    this.since = null
  }

  toggle(): void {
    if (this.running) this.pause()
    else this.start()
  }

  /** 歸零；正在計時就從 0 繼續跑，暫停中就停在 0 */
  reset(): void {
    this.base = 0
    if (this.since !== null) this.since = this.now()
  }
}
