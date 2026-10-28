/** 經過時間：未滿一小時 m:ss，之後 h:mm:ss */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** 現在時間 H:MM */
export function formatClock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 連線延遲的等級，用來上色 */
export function latencyLevel(ms: number): 'good' | 'ok' | 'poor' {
  return ms < 200 ? 'good' : ms < 500 ? 'ok' : 'poor'
}
