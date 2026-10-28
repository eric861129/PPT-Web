// 播放狀態與指令。鍵盤、滑鼠、之後的手機遙控都送同一套 Command，
// 由 ShowController 統一套用，所以這裡不能依賴 DOM。

export type BlankMode = 'off' | 'black' | 'white'

export type Command =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'goto'; index: number }
  | { type: 'blank'; mode: BlankMode }
  | { type: 'toggleBlank'; mode: Exclude<BlankMode, 'off'> }

export interface ShowState {
  index: number
  blank: BlankMode
}

export function applyCommand(state: ShowState, cmd: Command, pageCount: number): ShowState {
  const last = Math.max(0, pageCount - 1)
  const clamp = (i: number) => Math.min(last, Math.max(0, i))

  switch (cmd.type) {
    case 'next':
    case 'prev':
    case 'first':
    case 'last': {
      // 跟 PowerPoint 一樣：黑幕時按翻頁只會先回到畫面，不會跳頁
      if (state.blank !== 'off') return { ...state, blank: 'off' }
      const index =
        cmd.type === 'next' ? state.index + 1
        : cmd.type === 'prev' ? state.index - 1
        : cmd.type === 'first' ? 0
        : last
      return { ...state, index: clamp(index) }
    }
    case 'goto':
      return { index: clamp(cmd.index), blank: 'off' }
    case 'blank':
      return { ...state, blank: cmd.mode }
    case 'toggleBlank':
      return { ...state, blank: state.blank === cmd.mode ? 'off' : cmd.mode }
  }
}

export class ShowController {
  private state: ShowState = { index: 0, blank: 'off' }
  private readonly listeners = new Set<(state: ShowState) => void>()

  constructor(readonly pageCount: number) {}

  get current(): ShowState {
    return this.state
  }

  dispatch(cmd: Command): void {
    const next = applyCommand(this.state, cmd, this.pageCount)
    if (next.index === this.state.index && next.blank === this.state.blank) return
    this.state = next
    for (const fn of this.listeners) fn(next)
  }

  subscribe(fn: (state: ShowState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}
