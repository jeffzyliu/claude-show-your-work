// The tour's stops, and how a press in the player ticks the one it asked for.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { state } from './state'

// The settings pane's and the tour's redraws. Declared in each file that
// reads or updates it: the engine only reads an atom declared in the same file.
const welcome = atom({ plugin: 'show-your-work', key: 'welcome' } as const, 0)

// Each stop points at one real control (spot) with one short line (tag), and
// is done when the person uses it (goal: the act() name its button fires).
type Spot = 'play' | 'changes' | 'tabs' | 'history'
export type Stop = { tag: string; spot?: Spot; goal?: string; media?: 'splash' | 'recording' | 'compare' | 'history' }
export const STOPS: Stop[] = [
  { tag: 'Press Play to watch it', spot: 'play', goal: 'play', media: 'splash' },
  { tag: 'Click a change to jump to that moment', spot: 'changes', goal: 'change_jump', media: 'recording' },
  { tag: 'Press Original to see it before the change', spot: 'tabs', goal: 'original', media: 'compare' },
  { tag: 'Open History, then pick a version', spot: 'history', goal: 'version_pick', media: 'history' },
  { tag: 'Now ask Claude to show you what it builds' },
]

// A button press, heard: when it is what the stop asked for, it ticks; the
// person moves on with Next when they're ready.
export function tourHeard($: EngineInterface, action: string) {
  const s = STOPS[state.tourStop]
  if (!state.tourSite || state.isTourDone || state.isStopDone || !s?.goal || s.goal !== action) return
  state.isStopDone = true
  // Sent once per step, numbered from 0 like tour_next_N and tour_skip_N, so a
  // funnel can tell people who did the step from people who only pressed Next.
  void update($, welcome, n => n + 1)
}
