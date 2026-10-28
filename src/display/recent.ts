// 最近開過的簡報：PDF（和 PPTX）存在這個瀏覽器的 IndexedDB 裡，
// 下次點一下就能開，電腦端重新整理時也能自動恢復。檔案不會離開這台電腦。
// 無痕模式或儲存空間被封鎖時，所有操作都安靜地失敗，不影響開簡報。
import { createStore, del, delMany, get, set, type UseStore } from 'idb-keyval'

export interface RecentDeck {
  id: string
  title: string
  pageCount: number
  hasPptx: boolean
  openedAt: number
  /** 第一頁的小縮圖 */
  thumb?: Blob
}

export interface StoredDeckFiles {
  pdf: File
  pptx?: File
}

export const MAX_RECENT = 6
const LIST_KEY = 'list'
const filesKey = (id: string) => `files:${id}`

let store: UseStore | null | undefined
function db(): UseStore | null {
  if (store === undefined) {
    try {
      store = typeof indexedDB === 'undefined' ? null : createStore('ppt-web', 'recent')
    } catch {
      store = null
    }
  }
  return store
}

/** 同一個 PDF 檔（名稱、大小、修改時間都一樣）只留一筆 */
export function deckId(pdf: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${pdf.name}|${pdf.size}|${pdf.lastModified}`
}

/** 把 entry 放到最前面；超過上限時回傳被擠掉的 id */
export function upsertRecent(list: readonly RecentDeck[], entry: RecentDeck, max = MAX_RECENT): { list: RecentDeck[]; dropped: string[] } {
  const rest = list.filter((d) => d.id !== entry.id)
  const next = [entry, ...rest]
  return { list: next.slice(0, max), dropped: next.slice(max).map((d) => d.id) }
}

export async function listRecent(): Promise<RecentDeck[]> {
  const s = db()
  if (!s) return []
  try {
    return (await get<RecentDeck[]>(LIST_KEY, s)) ?? []
  } catch {
    return []
  }
}

export async function saveRecent(files: StoredDeckFiles, info: { title: string; pageCount: number }): Promise<string | null> {
  const s = db()
  if (!s) return null
  const id = deckId(files.pdf)
  try {
    const old = (await listRecent()).find((d) => d.id === id)
    const entry: RecentDeck = { id, title: info.title, pageCount: info.pageCount, hasPptx: !!files.pptx, openedAt: Date.now() }
    if (old?.thumb) entry.thumb = old.thumb
    const { list, dropped } = upsertRecent(await listRecent(), entry)
    await set(filesKey(id), files, s)
    await set(LIST_KEY, list, s)
    if (dropped.length) await delMany(dropped.map(filesKey), s)
    return id
  } catch {
    return null
  }
}

export async function setRecentThumb(id: string, thumb: Blob): Promise<void> {
  const s = db()
  if (!s) return
  try {
    const list = await listRecent()
    const entry = list.find((d) => d.id === id)
    if (!entry) return
    entry.thumb = thumb
    await set(LIST_KEY, list, s)
  } catch {
    // 縮圖存不了不影響使用
  }
}

export async function loadRecent(id: string): Promise<StoredDeckFiles | null> {
  const s = db()
  if (!s) return null
  try {
    const files = await get<StoredDeckFiles>(filesKey(id), s)
    return files?.pdf ? files : null
  } catch {
    return null
  }
}

export async function removeRecent(id: string): Promise<void> {
  const s = db()
  if (!s) return
  try {
    await set(LIST_KEY, (await listRecent()).filter((d) => d.id !== id), s)
    await del(filesKey(id), s)
  } catch {
    // 下次再試
  }
}

export async function clearRecent(): Promise<void> {
  const s = db()
  if (!s) return
  try {
    const ids = (await listRecent()).map((d) => d.id)
    await delMany([LIST_KEY, ...ids.map(filesKey)], s)
  } catch {
    // 下次再試
  }
}

const relative = new Intl.RelativeTimeFormat('zh-Hant', { numeric: 'auto' })

/** 「剛剛」「5 分鐘前」「昨天」「3 天前」 */
export function relativeTime(then: number, now = Date.now()): string {
  const minutes = Math.round((then - now) / 60000)
  if (minutes > -1) return '剛剛'
  if (minutes > -60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return relative.format(hours, 'hour')
  return relative.format(Math.round(hours / 24), 'day')
}
