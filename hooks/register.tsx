// The entry module: the tools and commands, and the hooks that tie the
// modules together.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Check, KeyChange, Overlay, Shown, Summary } from '../types'

import { state } from './state'
import { clock, paneSize } from './layout'
import type { PaneProps } from './layout'
import { debug, diagnosis, flushDebug } from './diagnostics'
import { setUp } from './setup'
import { haltAllSound, soundUsable } from './sound'
import { isDocument, prepareDocument } from './document'
import { forwardPictures, stopForwarding } from './tmux'
import { CLEAN_SH, exists, expand, findPasted, identityOf, imageBlocks, isAudio, isPage, keyOf, locate, NO_FFMPEG, noticeOf, prepare, preparePair, renderPage, shiftTimes, trimFrames, VIDEO } from './media'
import type { Notice } from './media'
import { handleOf, MARK, noteOf, preparedOf, remember, shownById, shownOf, storeOf, storeVersion, textOf, timesThatMean, versionsOf } from './history'
import { hadVersionBefore06, PLUGIN } from './updater'
import { atStep, cantDraw, causeOf, draw, mayBeDropped, noteDrawn, NO_PLACEHOLDERS, NoticeBox, player, removePicturesLine, sideOf, UNRECOGNISED, stop, terminalOf, toolHead, toolLine, toolName, versions, Viewer } from './player'
import type { Ui } from './player'
import { ensureSettings, goToStop, loadSettings, Opening, openSettings, openUpdate, openWelcome, Settings, startBackground, startTour, Tour, TOUR_TEXT, UPDATE, UpdatePane, WELCOME_TEXT } from './onboarding'

const PANE = 'show-your-work'
// The tools, and their names from before the rename, so old windows still draw.
const TOOLS = ['show_image', 'show_video', 'show_html', 'show_audio', 'show_document'].map(t => `mcp__show-your-work__${t}`)
// Screenshots and recordings made only to be shown go to the temp folder, so
// they don't pile up in the project; the history keeps its own copy.
// Said once, in the session hint, not in every tool description.
const SCRATCH_NOTE = ' Save screenshots and recordings to $TMPDIR or /tmp, not the project, unless asked to keep them.'
// What can be shown at all: anything else is refused before it is copied.
const MEDIA = /\.(png|jpe?g|webp|gif|tiff?|heic|heif|bmp|avif|mp4|mov|m4v|webm|mkv|avi)$/i
// The settings pane. A hook's filter is read from a const in this file, so its
// id is spelled here as well as in onboarding.tsx.
const WELCOME = 'show-your-work-welcome'
const current = atom({ plugin: 'show-your-work', key: 'current' } as const, null)
// The settings pane's and the tour's redraws. Declared in each file that
// reads or updates it: the engine only reads an atom declared in the same file.
const welcome = atom({ plugin: 'show-your-work', key: 'welcome' } as const, 0)
// Which other tools' calls show their full output under the picture, by tool_use_id.
const outputOpen = atom({ plugin: 'show-your-work', key: 'outputOpen' } as const, {} as Record<string, boolean>)
let pastedNames: string[] = []
// Each failed show's notice, by tool call, for the box drawn in its place.
const notices = new Map<string, Notice>()
// Each window's last drawing, handed back while nothing it shows changed.
const drawn = new Map<string, { key: string; tree: unknown; view: Shown }>()
// The pictures in another tool's result, made once per result.
const found = new Map<string, Promise<Shown | null>>()
// The calls whose group this plugin unfolded itself (see the ToolGroup hook): their rows read `isExpanded` as true without anyone having asked for the full output.
const unfolded = new Set<string>()
// Writes each image block to the temp folder and prepares it. Two to four
// pictures are a row, more a carousel; a tool's own name titles them.
async function picturesOf($: EngineInterface, tool: string, id: string, blocks: { ext: string; data: string }[]): Promise<Shown | null> {
  await setUp($)
  const label = toolName(tool)
  const items: Shown[] = []
  for (const [i, block] of blocks.entries()) {
    const file = `${state.TMP}/mcp-${keyOf(`${id}|${i}|${block.data.length}|${block.data.slice(-48)}`)}.${block.ext}`
    if (!(await exists($, file))) {
      const r = await $.process.run(['sh', '-c', 'base64 -d > "$1"', 'sh', file], { stdin: block.data }).catch(() => null)
      if (!r || r.exitCode !== 0) continue
    }
    const title = blocks.length > 1 ? `${label} (${i + 1}/${blocks.length})` : label
    try { items.push({ ...(await prepare($, file, title)), origin: file }) } catch { /* a block that isn't a picture is skipped */ }
  }
  if (!items.length) return null
  if (items.length === 1) return items[0]!

  return { ...items[0]!, carousel: items, ...(items.length <= 4 ? { isRow: true, title: label } : {}) }
}

// Schemas are kept minimal: they are sent to Claude on every turn a tool is loaded.
// The handler still accepts pr, url, label, compare_label, changes_title, versions and the
// finer fields (detail, passed, total, step); they are just not advertised.
const STR = { type: 'string' }
const CHECKS = {
  type: 'array',
  description: 'Checks run: name, ok, at (seconds), expected/actual when failed',
  items: { type: 'object', properties: { name: STR, ok: { type: 'boolean' }, at: { type: 'number' }, expected: STR, actual: STR }, required: ['name', 'ok'] },
}
const CHANGES = {
  type: 'array',
  description: 'What changed: title, at (seconds)',
  items: { type: 'object', properties: { title: STR, at: { type: 'number' } }, required: ['title'] },
}
const SUMMARY = {
  type: 'array',
  description: 'QA lines you ran, up to 3',
  items: { type: 'object', properties: { label: STR, ok: { type: 'boolean' } }, required: ['label', 'ok'] },
}
const object = (properties: Record<string, unknown>, required: string[] = ['path']) => ({ type: 'object', properties, required })
const PATH = { type: 'string', description: 'Absolute path' }
const TITLE = { type: 'string', description: 'Short caption' }
const PREVIOUS = { type: 'string', description: '#id of the version this revises' }

const PLAIN_INPUT = object({ path: PATH, title: TITLE })
const AUDIO_INPUT = object({ path: PATH, title: TITLE, changes: CHANGES, checks: CHECKS })
const VIDEO_INPUT = object({
  path: PATH, title: TITLE, changes: CHANGES, checks: CHECKS, summary: SUMMARY, previous: PREVIOUS,
  compare: { type: 'string', description: 'Before version' }, compare_checks: CHECKS,
})
const SHOW_IMAGE_INPUT = object({
  path: PATH, title: TITLE, changes: CHANGES, summary: SUMMARY, previous: PREVIOUS,
  compare: { type: 'string', description: 'Before image' },
  paths: { type: 'array', items: STR, description: 'Several images (max 12) instead of path' },
  layout: { type: 'string', enum: ['carousel', 'row'] },
  titles: { type: 'array', items: STR, description: 'One short title per path' },
}, [])
const MAX_PICTURES = 12
// A title in a row is cut to its picture's width; this keeps one long one from taking over.
const TITLE_MAX = 40
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
// Base64 or a data: address, not a path: long, with no extension, or only base64 characters.
const isImageData = (p: string) => /^data:/i.test(p.trim()) || p.length > 4096 || /^[A-Za-z0-9+/=\s]{256,}$/.test(p)

// The line that stands for another tool's call: a green bullet and the bold
// name, as Claude Code's own rows read. A click shows or hides core's full row,
// the call and its output. (Button holds styled Text only on 2.1.295+.)
function callHeader($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], tool: string, callId: string) {
  const { Button, Text } = $.ui.resolve(e) as Ui
  const name = toolName(tool)
  const toggle = () => { void update($, outputOpen, open => ({ ...open, [callId]: !open[callId] })) }

  return state.canColourButtons
    ? <Button key={`output-${callId}`} plain label={`⏺ ${name}`} onPress={toggle}><Text color="green">⏺</Text><Text> </Text><Text bold>{name}</Text></Button>
    : <Button key={`output-${callId}`} plain label={`⏺ ${name}`} onPress={toggle} />
}

// Draws a tool's result row: the player for this plugin's own tools, any pictures in another tool's output under its ToolUse row.
type RowTarget = Parameters<EngineInterface['ui']['resolve']>[0] & { requestId: string; props: unknown; viewport?: { columns: number; rows: number } }
async function drawResult<E extends RowTarget>($: EngineInterface, e: E, next: (e: E) => Promise<RenderElement> | RenderElement): Promise<RenderElement> {
  const props = e.props as { tool: string; output: unknown; isErrored: boolean; onScreen?: unknown }
  // Another tool's call: its own row, then any pictures in its output.
  const isMine = TOOLS.includes(props.tool)
  const blocks = isMine || props.isErrored ? [] : imageBlocks(props.output)
  if (!isMine && !blocks.length) return next(e)
  // The picture stands for the call, so core's row (the call's input and its
  // whole result text, which the unfolded group draws inline) gives way to one
  // line naming the tool.
  let row: unknown = null
  if (!isMine) {
    const { Box } = $.ui.resolve(e) as Ui
    const callId = (props as { tool_use_id?: string }).tool_use_id ?? e.requestId
    const isOpen = (await read($, outputOpen))[callId] === true
    const header = callHeader($, e, props.tool, callId)
    // Expanded (ctrl+o, --verbose): core's full row always shows, as for any tool.
    const isAsked = (props as { isExpanded?: boolean }).isExpanded === true && !unfolded.has(callId)
    row = isOpen || isAsked ? <Box flexDirection="column">{header}{await next(e)}</Box> : header
  }
  if (props.isErrored) {
    const n = notices.get((props as { tool_use_id?: string }).tool_use_id ?? '') ??
      (textOf(props.output).includes(NO_FFMPEG) ? noticeOf(new Error(NO_FFMPEG), '') : undefined)
    if (!n) return next(e)
    return NoticeBox($.ui.resolve(e) as Ui, $, (e.viewport?.columns ?? 100) - 8, { ...n, copy: n.prompt, label: 'Copy prompt', action: `copy_${n.kind}_prompt` })
  }
  // Scrolled out of view: stop playing.
  const one = player(e.requestId)
  if (props.onScreen === null) {
    if (one.timer) stop($, e.requestId)
    if (!one.wasAway) debug(`away ${e.requestId}`)
    one.wasAway = true
  } else if (one.wasAway && props.onScreen) {
    // Back in view. The layout hasn't changed, so the kept drawing stands;
    // only the picture is sent again, as the terminal may have dropped it.
    one.wasAway = false
    one.resend = true
    debug(`back ${e.requestId}`)
  }
  const key = `${state.version}|${versions.get(e.requestId) ?? 0}|${e.viewport?.columns ?? 0}|${e.viewport?.rows ?? 0}`
  const kept = drawn.get(e.requestId)
  let tree = kept?.key === key ? (kept.tree as Awaited<ReturnType<typeof Viewer>>) : null
  let view = kept?.view
  if (!tree || !view) {
    // After /reload-plugins nothing else has set up the folders yet: without
    // this the result looks for its picture in the wrong place and collapses.
    await setUp($)
    await ensureSettings($)
    let made = isMine ? undefined : found.get(e.requestId)
    if (!isMine && !made) found.set(e.requestId, (made = picturesOf($, props.tool, e.requestId, blocks)))
    const shown = isMine ? await shownOf($, props.output) : await made!
    if (!shown) { found.delete(e.requestId); return next(e) }
    view = atStep(shown, e.requestId)
    tree = await Viewer($, e, view, e.requestId, false, e.viewport)
    drawn.set(e.requestId, { key, tree, view })
    if (kept?.view === undefined) noteDrawn(e.requestId, view.width, view.height)
  }
  // Back in view: send the picture again at once, but only if the terminal
  // may have dropped it; otherwise it still has it and nothing is decoded.
  if (one.resend) {
    one.resend = false
    if (mayBeDropped(e.requestId)) {
      debug(`resend ${e.requestId}`)
      draw($, e.requestId, sideOf(view, e.requestId), view)
    }
  }

  if (row) {
    const { Box } = $.ui.resolve(e) as Ui
    return <Box flexDirection="column">{row}{tree}</Box>
  }

  return tree
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    state.cwd = started.cwd
    state.setup = null
    await setUp($)
    state.sessionId = await $.session.id().catch(() => '')
    state.sentHint = ''
    state.hasVideoTools = false
    await loadSettings($)
    void (async () => {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
      state.pluginVersion = manifest.version ?? '0.0.0'
      const program = (await $.env.get('TERM_PROGRAM')) ?? ''
      const term = (await $.env.get('TERM')) ?? ''
      const herdrApp = !!(await $.env.get('HC_TERMINAL_ID')) || (await $.env.get('__CFBundleIdentifier')) === 'dev.herdr.app'
      const terminal = terminalOf({ program, term, kitty: !!(await $.env.get('KITTY_WINDOW_ID')), konsole: !!(await $.env.get('KONSOLE_VERSION')), lcTerminal: (await $.env.get('LC_TERMINAL')) ?? '', herdrApp })
      state.terminalName = terminal
      state.isForced = /^(1|true|on|yes)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '')
      // iTerm2 and the Herdr app draw pictures from bytes only, never from a file they're named.
      if (terminal === 'iterm2' || terminal === 'herdr_app') state.sendBytes = true
      state.inTmux = !!(await $.env.get('TMUX')) || /^tmux/i.test(term)
      state.isDebug = /^(1|true|on|yes)$/i.test((await $.env.get('SHOW_YOUR_WORK_DEBUG')) ?? '')
      if (state.isDebug) $.clock.every(1000, () => void flushDebug($))
      // Terminals that can't paint Claude Code's placeholders never show a
      // picture, and tmux only with pictures forced on: known before the
      // first one.
      void removePicturesLine($)
      const isForwarded = state.inTmux && (await forwardPictures($))
      // The desktop app's Code tab draws no pictures (#18).
      const isDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
      // Rex and the Herdr app draw nothing until Claude Code starts with FORCE.
      const isOff = !state.inTmux && !!UNRECOGNISED[state.terminalName] && !state.isForced
      if (isDesktop || (state.inTmux && !isForwarded) || NO_PLACEHOLDERS[state.terminalName] || isOff) {
        state.canImage = false
        state.probed = true
        state.drawCause = isDesktop ? 'desktop' : NO_PLACEHOLDERS[state.terminalName] ? 'terminal' : causeOf(state.inTmux, state.terminalName, state.isForced)
      }
      // Every install sees the welcome and tour once, an update included:
      // installs from before 0.6.2 never had one. 0.6.0 stored 'welcomed' both
      // when it showed the welcome and when it skipped it for an update; an
      // older version's folder still beside this one marks the update.
      state.isWelcomed = !!(await $.store.get('toured'))
      if (!state.isWelcomed && await $.store.get('welcomed')) {
        const versions = await $.fs.list($.plugin.root.replace(/\/+$/, '').replace(/\/[^/]+$/, '')).catch(() => [])
        if (!hadVersionBefore06(versions.map(f => f.name))) {
          state.isWelcomed = true
          await $.store.set('toured', true)
        }
      }
      // An update keeps what it already ran: its updates start
      // now, and only a fresh install waits for the welcome.
      const isUpdate = (await Promise.all(['welcomed', 'installId', 'updateCheckedAt'].map(key => $.store.get(key)))).some(value => value !== undefined && value !== null)
      if (!state.isWelcomed && isUpdate) await startBackground($)
      if (state.isWelcomed) await startBackground($)
      else await openWelcome($)
    })().catch(() => undefined)
    // Frames and converted pictures a week old go; a window that scrolls back
    // into view cuts its frames again from the source.
    void $.process.run(['sh', '-c', CLEAN_SH, state.TMP]).then(() => trimFrames($))
    await $.command.register({
      name: 'show-your-work',
      description: 'Settings for show-your-work; /show-your-work tour for the tour, /show-your-work update to check for updates, /show-your-work diagnose for recent problems',
      argumentHint: '[settings|tour|update|diagnose]',
    })
    await $.command.register({
      name: 'img',
      description: 'Show an image or video in the chat: /img <path>',
      argumentHint: '<path>',
    })
    await $.command.register({
      name: 'page',
      description: 'Show a local HTML page in your terminal: /page <path>. Open page opens the live page.',
      argumentHint: '<path>',
    })
    await $.command.register({
      name: 'audio',
      description: 'Play an audio file in your terminal: /audio <path>',
      argumentHint: '<path>',
    })
    await $.command.register({
      name: 'doc',
      description: 'Show a PDF, Markdown or Mermaid document in your terminal: /doc <path>',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'show_document',
      description: 'Shows a PDF, Markdown or Mermaid (.mmd) file inline as pages. Use when the user asks to see or read a report, document or diagram.',
      inputSchema: PLAIN_INPUT,
      isDeferred: false,
    })
    // Only with a browser to render pages: without one, Claude screenshots
    // with Playwright and uses show_image.
    if (state.chrome) await $.tool.register({
      name: 'show_html',
      description: 'Shows a local .html file as a static 1280x800 preview inline. Use for reports, page designs and small artifacts.',
      inputSchema: PLAIN_INPUT,
      isDeferred: true,
    })
    await $.tool.register({
      name: 'show_audio',
      description: 'Plays an MP3 or WAV file inline. Use when the user asks to hear something. changes and checks mark moments in the clip.',
      inputSchema: AUDIO_INPUT,
      isDeferred: true,
    })
    await $.tool.register({
      name: 'show_image',
      description: 'Shows images inline in the terminal (PNG, JPEG, WebP, GIF, TIFF). Use unasked after any visual work, before saying it is done, instead of asking the user to open a file. For changed work pass changes and compare (the before image). paths shows several as a carousel, or a row with layout "row". The user sees it; you do not.',
      inputSchema: SHOW_IMAGE_INPUT,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show_video',
      description: 'Plays a video inline (MP4, MOV, WebM, GIF; keep it short). Use unasked after building or fixing an interactive feature: record a headless Playwright run. Pass changes and checks with at (seconds); for a fix, compare is the before clip, with compare_checks. The user sees it; you do not.',
      inputSchema: VIDEO_INPUT,
      isDeferred: true,
    })

    return started
  })

  // While pictures draw, Claude is told up front that it can show its work,
  // so it does so without being asked. Once a draw has failed, the next turn
  // knows instead: what was "shown" was a notice, not the picture.
  // Sent as the prompt's context, once per session and again after a
  // compaction or a change: prompt.compose is skipped on Team and Enterprise
  // logins, where Claude Code's own guard runs ahead of every mod (#13).
  on('session.compact', ($, e, next) => {
    if (!e.agentId) state.sentHint = ''

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // The next session starts with sound on, and nothing sounds past this one.
    state.isSoundOn = true
    haltAllSound('session_end')
    await stopForwarding($)

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    // Sending a message puts the settings away.
    if (e.origin?.kind !== 'plugin') void $.ui.panes().then(panes => { if (panes.some(p => p.id === WELCOME)) return $.ui.close({ id: WELCOME }) }).catch(() => undefined)
    pastedNames = (e.attachments ?? []).filter(a => a.type === 'image' && a.filename).map(a => a.filename!)
    const hint = hintNow()
    if (e.command || hint === state.sentHint) return next(e)
    state.sentHint = hint

    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  on('command.run', { command: 'img' }, async ($, invoked) => {
    await setUp($)
    let arg = invoked.args.trim()
    if (/^\[Image #\d+\]$/.test(arg) || (!arg && pastedNames.length > 0)) {
      const name = pastedNames.at(-1)
      const found = name ? await findPasted($, name) : null
      if (!found) {
        return {
          text: 'Pasted images reach Claude, not mods, so /img cannot read one. Drag the file into the prompt (that types its path) or type the path: /img ~/path/to/file.png',
        }
      }
      arg = found
    }
    if (!arg) return { text: 'Usage: /img <path>' }
    try {
      const shown = await prepare($, arg)
      // Drawn in the chat, in this command's own row, by the CommandOutput hook.
      const id = keyOf(`${arg}|${await $.clock.now()}`).slice(0, 10)
      shownById.set(id, shown)
      // Saved beside the history too, so the row still draws after a reload
      // wipes the module's memory.
      await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${id}.shown`, JSON.stringify(shown)]).catch(() => undefined)

      return { text: `Showing ${shown.title}.\n${MARK}#${id}` }
    } catch (err) {
      const n = noticeOf(err, expand(arg, state.cwd, state.home), state.home)
      return { text: n.message }
    }
  })

  on('command.run', { command: 'page' }, async ($, invoked) => {
    await setUp($)
    const arg = expand(invoked.args.trim(), state.cwd, state.home)
    if (!invoked.args.trim()) return { text: 'Usage: /page <path to a local .html file>' }
    if (!isPage(arg)) return { text: 'Pages are .html or .htm files. For images and videos use /img <path>.' }
    try {
      const shown = await prepare($, arg, `Page · ${arg.split('/').pop()}`)
      const id = keyOf(`${arg}|${await $.clock.now()}`).slice(0, 10)
      shownById.set(id, shown)
      await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${id}.shown`, JSON.stringify(shown)]).catch(() => undefined)

      return { text: `Previewing ${shown.title}. Open page opens it in your browser.\n${MARK}#${id}` }
    } catch (err) {
      const n = noticeOf(err, arg, state.home)
      return { text: n.message }
    }
  })

  on('command.run', { command: 'audio' }, async ($, invoked) => {
    await setUp($)
    const arg = expand(invoked.args.trim(), state.cwd, state.home)
    if (!invoked.args.trim()) return { text: 'Usage: /audio <path to a local .mp3 or .wav file>' }
    if (!isAudio(arg)) return { text: 'Audio is .mp3 or .wav files. For images and videos use /img <path>, for HTML pages /page <path>.' }
    try {
      const shown = await prepare($, arg)
      const id = keyOf(`${arg}|${await $.clock.now()}`).slice(0, 10)
      shownById.set(id, shown)
      await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${id}.shown`, JSON.stringify(shown)]).catch(() => undefined)

      return { text: `Showing ${shown.title}.${soundUsable() ? ' Press Play to hear it.' : ''}\n${MARK}#${id}` }
    } catch (err) {
      const n = noticeOf(err, arg, state.home)
      return { text: n.message }
    }
  })

  on('command.run', { command: 'doc' }, async ($, invoked) => {
    await setUp($)
    const arg = expand(invoked.args.trim(), state.cwd, state.home)
    if (!invoked.args.trim()) return { text: 'Usage: /doc <path to a local .pdf, .md or .mmd file>' }
    if (!isDocument(arg)) return { text: 'Documents are .pdf, .md, .markdown, .mmd or .mermaid files. For images, videos and audio use /img <path>, for HTML pages /page <path>.' }
    try {
      const shown = await prepareDocument($, arg, arg.split('/').pop()!)
      const id = keyOf(`${arg}|${await $.clock.now()}`).slice(0, 10)
      shownById.set(id, shown)
      await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${id}.shown`, JSON.stringify(shown)]).catch(() => undefined)

      return { text: `Showing ${shown.title} (${shown.pages?.count ?? 1} page${(shown.pages?.count ?? 1) === 1 ? '' : 's'}).\n${MARK}#${id}` }
    } catch (err) {
      const n = noticeOf(err, arg, state.home)
      return { text: n.message }
    }
  })

  on('tool.call', { tool: /^mcp__show-your-work__show_(image|video|html|audio|document)$/ }, async ($, e) => {
    const input = { ...e } as unknown as {
      path?: string; title?: string; change?: string; pr?: string; changes?: KeyChange[]; summary?: Summary[]; url?: string; checks?: Check[]
      compare?: string; compare_checks?: Check[]; label?: string; compare_label?: string; overlay?: Overlay; versions?: unknown; previous?: string; changes_title?: string
    }
    const extra = e as unknown as { paths?: unknown; layout?: string; titles?: unknown }
    const toolName = String((e as { tool?: string }).tool ?? '')
    const listed = toolName.endsWith('show_image') && Array.isArray(extra.paths) ? (extra.paths as unknown[]).filter((p): p is string => typeof p === 'string' && !!p) : []
    if (!input.path && !listed.length) return { deny: 'A path is needed.' }
    // Image data (base64 or a data: address) is not a path: refuse it short,
    // so the data isn't echoed back in an error.
    const supplied = [input.path, input.compare, ...(Array.isArray(extra.paths) ? (extra.paths as unknown[]) : [])]
    if (supplied.some(p => typeof p === 'string' && isImageData(p))) return { deny: 'show_image takes file paths, not image data (base64 or a data: address). Save the image to a file first, then pass its path.' }
    // Several pictures: one short title each, or none (then each is named for its file).
    if (listed.length > 1 && Array.isArray(extra.titles) && extra.titles.length) {
      const bad = extra.titles.length !== listed.length || (extra.titles as unknown[]).some(t => typeof t !== 'string' || !t.trim())
      if (bad) return { deny: `titles must hold one short, non-empty title for each of the ${listed.length} paths (it holds ${extra.titles.length}), or be left out so each image is named for its file.` }
    }
    if (listed.length > MAX_PICTURES) return { deny: `At most ${MAX_PICTURES} images at once.` }
    await setUp($)
    // The history's copy of a file that then can't be shown goes again.
    let copied = ''
    try {
      // Several pictures: a carousel or a row starts from its first and gets
      // the rest once that one is prepared.
      let carousel: { path: string; title: string }[] = []
      if (listed.length > 1) {
        const where = await Promise.all(listed.map(p => locate($, p)))
        for (const p of where) if (!MEDIA.test(p) || VIDEO.test(p)) throw new Error(`not an image: ${p}`)
        const names = Array.isArray(extra.titles) ? (extra.titles as unknown[]) : []
        carousel = where.map((path, i) => ({
          path,
          title: typeof names[i] === 'string' && names[i] ? clip(names[i] as string, TITLE_MAX) : extra.layout !== 'row' && input.title ? `${input.title} (${i + 1}/${where.length})` : path.split('/').pop()!,
        }))
        input.path = carousel[0]!.path
        // A row's window is titled for the whole set; a carousel's for the picture on show.
        if (extra.layout === 'row') input.title ??= `${where.length} images`
        else input.title = carousel[0]!.title
        // Several pictures have no before and after.
        input.compare = input.previous = input.versions = undefined
      } else if (listed.length === 1) input.path = listed[0]
      input.path = await locate($, input.path!)
      if (input.compare) input.compare = await locate($, input.compare)
      const note = noteOf(input.changes, input.change, input.title)
      const parent = handleOf(input.previous)
      // Only pictures and videos are copied into the history: never a key or
      // a config file a model was talked into naming. A page is rendered from
      // where it lies, so its relative assets resolve; history keeps the
      // picture, and the card's source stays the page itself, so Open page
      // opens it.
      const page = isPage(input.path)
      const audio = isAudio(input.path)
      const document = isDocument(input.path)
      if (String((e as { tool?: string }).tool ?? '').endsWith('document') && !document)
        throw new Error(`not a document: ${input.path}`)
      if (String((e as { tool?: string }).tool ?? '').endsWith('audio') && !audio)
        throw new Error(`not audio: ${input.path}`)
      if (!MEDIA.test(input.path) && !page && !audio && !document) throw new Error(`not an image: ${input.path}`)
      const pagePng = page ? await renderPage($, input.path, keyOf(`${input.path}|${await $.clock.now()}`).slice(0, 10)) : undefined
      const kept = await storeVersion($, pagePng ?? input.path!, note, input.title, parent)
        .catch(() => ({ real: pagePng ?? input.path!, copy: pagePng ?? input.path!, id: '', chain: [] as { path: string; note?: string; id: string }[], missing: undefined as string | undefined }))
      if (kept.copy !== kept.real) copied = kept.copy
      // Every earlier version: the ones handed in, then the ones shown before.
      const given = await Promise.all(versionsOf(input.versions).map(async v => ({ ...v, path: await locate($, v.path) })))
      const earlier = [...given, ...kept.chain.filter(k => !given.some(g => g.path === k.path))]
      const compare = input.compare ?? earlier.at(-1)?.path
      const shown: Shown = {
        ...(document
          ? await prepareDocument($, kept.copy, input.title ?? input.path.split('/').pop()!, input.path)
          : await prepare($, kept.copy, input.title ?? (page ? `Page · ${input.path.split('/').pop()}` : input.path.split('/').pop()), await identityOf($, input.path))),
        origin: page ? input.path : kept.real,
        change: input.change,
        pr: input.pr,
        url: input.url,
        checks: input.checks,
        changes: timesThatMean(input.changes, VIDEO.test(input.path) || audio),
        summary: input.summary,
        label: input.label,
        overlay: input.overlay,
        note,
        ...(input.changes_title ? { changesTitle: String(input.changes_title).slice(0, 28) } : {}),
      }
      if (carousel.length) {
        const first = { kind: shown.kind, path: shown.path, source: shown.source, origin: shown.origin, width: shown.width, height: shown.height, sourceWidth: shown.sourceWidth, sourceHeight: shown.sourceHeight, title: carousel[0]!.title, generation: shown.generation } as Shown
        const rest: Shown[] = []
        for (const item of carousel.slice(1)) {
          const kept = await storeVersion($, item.path, '', item.title, undefined).catch(() => null)
          rest.push({ ...(await prepare($, kept?.copy ?? item.path, item.title)), origin: kept?.real ?? item.path })
        }
        shown.carousel = [first, ...rest]
        if (extra.layout === 'row') shown.isRow = true
      }
      const lead = shown.frames?.lead ?? 0
      shown.checks = shiftTimes(shown.checks, lead)
      shown.changes = shiftTimes(shown.changes, lead)
      if (compare) {
        const label = input.compare_label
        shown.compare = {
          ...(isDocument(compare)
            ? await prepareDocument($, compare, label ?? 'Original', compare)
            : input.compare
              ? await prepare($, compare, label ?? 'Original')
              : await preparedOf($, compare)),
          label,
          checks: input.compare_checks,
        }
        shown.compare.checks = shiftTimes(shown.compare.checks, shown.compare.frames?.lead ?? 0)
        // Pictures step back through every earlier version; a clip has only
        // Original and Updated.
        if (!shown.frames && earlier.length > 1) {
          shown.history = input.compare && !earlier.some(v => v.path === compare) ? [{ path: compare }, ...earlier] : earlier
          shown.historyAt = shown.history.findIndex(v => v.path === compare)
          remember(compare, shown.compare)
        }
        if (shown.frames && shown.compare.frames) Object.assign(shown, (await preparePair($, shown.compare, shown)) ?? {})
      }
      if (!shown.frames && kept.copy !== kept.real)
        remember(kept.copy, { kind: shown.kind, path: shown.path, source: shown.source, width: shown.width, height: shown.height, title: 'Original', generation: shown.generation })
      const what = shown.carousel ? `${shown.carousel.length} images, ${shown.isRow ? 'a row' : 'a carousel'}` : shown.kind === 'audio' ? `audio, ${clock(shown.frames!.duration)}` : shown.kind === 'document' ? `document, ${shown.pages?.count ?? 1} pages` : shown.frames ? `video, ${clock(shown.frames.duration)}` : `${shown.sourceWidth ?? shown.width}×${shown.sourceHeight ?? shown.height}`

      const handle = kept.id ? ` #${kept.id}${kept.chain.length ? `, version ${kept.chain.length + 1} after #${kept.chain.at(-1)!.id}` : ''}.` : ''
      const hint = (kept.missing ? ` #${kept.missing} wasn't found, so this has no history.` : '') + handle
      const opening = state.canImage
        ? `Shown: ${shown.title} (${what}).`
        : `Not shown: ${cantDraw(state.drawCause, shown.title, shown.kind === 'audio' ? 'audio' : shown.kind === 'document' ? 'document' : shown.frames ? 'video' : 'picture', state.sessionId).claude} Don't say it was shown.`
      // Claude gets one short line; the drawing data stays out of its context.
      let mark = JSON.stringify(shown)
      if (kept.id) {
        const saved = await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', `${await storeOf($)}/${kept.id}.shown`, mark]).catch(() => null)
        if (saved && saved.exitCode === 0) {
          shownById.set(kept.id, shown)
          mark = `#${kept.id}`
        }
      }
      return { result: `${opening}${hint}\n${MARK}${mark}` }
    } catch (err) {
      if (copied) void $.process.run(['rm', '-f', '--', copied, copied.replace(/\.[^./]+$/, '.json')]).catch(() => undefined)
      const n = noticeOf(err, expand(input.path ?? '', state.cwd, state.home), state.home)
      notices.set(e.tool_use_id, n)
      return { deny: `show-your-work: ${n.message}` }
    }
  }).catch(() => ({ deny: 'show-your-work: it could not be shown.' }))

  // The call's own row: one short line, not the whole input.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const props = e.props as { tool: string; input: unknown; isRunning: boolean }
    if (!TOOLS.includes(props.tool)) return drawResult($, e, next)
    const { name, info } = toolLine(props.tool, props.input)

    return toolHead($.ui.resolve(e) as Ui, name, info, props.isRunning ? 'running' : (props as { isErrored?: boolean }).isErrored ? 'error' : 'done')
  })

  // A folded run of tool calls is one count line, and an MCP server's calls
  // fold into it. A picture drawn inside that line is part of the group, so a
  // click anywhere on its box (the edges, the gaps) expands the group. A group
  // that holds a picture is unfolded instead: each call is then a ToolUse row,
  // and drawResult draws its header and picture, outside any click of the group.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const ids = e.props.calls.map(call => call.tool_use_id).filter((id): id is string => !!id)
    // Expanded by the person (ctrl+o, --verbose): not ours, so its rows show their full output.
    if (e.props.isExpanded) {
      for (const id of ids) unfolded.delete(id)

      return next(e)
    }
    const hasPictures = e.props.calls.some(call => !call.isErrored && imageBlocks(call.output).length > 0)
    if (!hasPictures) return next(e)
    for (const id of ids) unfolded.add(id)

    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

  // Inline in the transcript: the player is the tool's result row. Another
  // tool's pictures are drawn from its ToolUse row instead (the engine passes
  // a ToolResult hook nothing for them, but ToolUse.output holds the blocks).
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!TOOLS.includes((e.props as { tool: string }).tool)) return next(e)

    return drawResult($, e, next)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const shown = await read($, current)
    if (!shown) return <Text dimColor>Nothing to show yet. Run /img path/to/file</Text>

    return Viewer($, e, atStep(shown, PANE), PANE, true, paneSize(e.viewport, e.props as PaneProps))
  })

  on('command.run', { command: 'show-your-work' }, async ($, invoked) => {
    await setUp($)
    if (/^tour$/i.test(invoked.args.trim())) {
      startTour($)
      return { text: TOUR_TEXT }
    }
    // What went wrong lately, for a bug report: problems noticed (always kept)
    // and where the full local log is. Nothing here is sent anywhere.
    if (/^diagnose$/i.test(invoked.args.trim())) return { text: diagnosis(await $.clock.now()) }
    if (/^update$/i.test(invoked.args.trim())) {
      void openUpdate($).catch(() => undefined)
      return { text: 'Checking for show-your-work updates.' }
    }
    // /show-your-work settings (or setting) opens them, never closes them.
    const isSettings = /^settings?$/i.test(invoked.args.trim())
    // Run again while they're open, the settings close.
    if (!isSettings && (await $.ui.panes()).some(pane => pane.id === WELCOME)) {
      await $.ui.close({ id: WELCOME })
      return { text: 'Closed the show-your-work settings.' }
    }
    await openSettings($)
    return { text: 'Opened the show-your-work settings.' }
  })

  on('ui.render', { component: 'Pane', requestId: UPDATE }, async ($, e) => {
    await setUp($)
    await read($, welcome)
    return UpdatePane($.ui.resolve(e) as Ui, $)
  })

  on('ui.render', { component: 'Pane', requestId: WELCOME }, async ($, e) => {
    await setUp($)
    await read($, welcome)
    await loadSettings($)
    return Settings($.ui.resolve(e) as Ui, $)
  })


  // The welcome's row: /show-your-work as the plugin ran it on install.
  const welcomeRows = new Set<string>()
  const tourRows = new Set<string>()
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const row = e.props as { command?: string; args?: string; text?: string; isErrored?: boolean; onScreen?: unknown }
    // /img and /page: the player, in the chat under the command.
    if ((row.command === 'img' || row.command === 'page' || row.command === 'audio' || row.command === 'doc') && !row.isErrored && (row.text ?? '').includes(MARK)) {
      await setUp($)
      await ensureSettings($)
      const shown = await shownOf($, row.text ?? '')
      if (!shown) {
        // A row from before a restart: the picture is no longer at hand.
        const { Text } = $.ui.resolve(e) as Ui
        return <Text dimColor>{(row.text ?? '').split('\n')[0]}</Text>
      }
      const one = player(e.requestId)
      if (row.onScreen === null && one.timer) stop($, e.requestId)
      return Viewer($, e, atStep(shown, e.requestId), e.requestId, false, e.viewport)
    }
    if (row.command !== PLUGIN) return next(e)
    if (/^tour$/i.test(row.args?.trim() ?? '') || (row.text ?? '').includes(TOUR_TEXT)) {
      // A tour row not drawn before is the newest: it becomes the live one.
      if (!tourRows.has(e.requestId)) {
        tourRows.add(e.requestId)
        const was = state.tourSite
        state.tourSite = e.requestId
        const isFresh = state.isTourPending || !was
        state.isTourPending = false
        // Drawing can't change state: the stop (re)starts just after.
        void $.clock.sleep(0).then(() => { if (was && was !== state.tourSite) stop($, was); goToStop($, isFresh ? 0 : state.tourStop) }, () => undefined)
      }
      if (e.requestId !== state.tourSite) {
        const { Text } = $.ui.resolve(e) as Ui
        return <Text dimColor>This tour moved to a newer one below.</Text>
      }
      // A plugin reload resets the module's state. setUp reads the Claude Code
      // version again, which decides whether buttons can have coloured text.
      await setUp($)
      await read($, welcome)
      return Tour($, e, e.viewport)
    }
    if (!welcomeRows.has(e.requestId)) {
      if (!(row.text ?? '').includes(WELCOME_TEXT)) return next(e)
      welcomeRows.add(e.requestId)
    }
    await setUp($)
    return Opening($, e, e.requestId, e.viewport)
  })
}

// What Claude is told about showing its work, for the state pictures are in now.
function hintNow() {
  // HTML pages are named only when a browser to render them was found.
  const audio = " When the user asks to hear something, or you've made audio, play it with show_audio (MP3 or WAV). When the user asks to see or read a report, PDF, Markdown document or Mermaid diagram, show it with show_document (PDF, MD or MMD); the person can turn its pages."
  if (state.canImage && !state.chrome) return `This terminal shows pictures, videos, audio and documents inline. After visual work, screenshot or record it and show it with show_image or show_video before you say you're done, instead of telling the user to open a file or localhost. For a UI fix, show before and after.${audio}${SCRATCH_NOTE}`
  if (state.canImage) return `This terminal shows pictures, videos, HTML pages, audio and documents inline. After visual work, show it instead of telling the user to open a file or localhost: an image or screenshot with show_image, a recording with show_video, an HTML file with show_html, each before you say you're done. For a UI fix, show before and after.${audio}${SCRATCH_NOTE}`
  const why = cantDraw(state.drawCause, 'it', 'picture', state.sessionId).claude.replace(/, so the person saw a notice instead of it\./, '.')
  return `show-your-work: pictures, videos, HTML pages, audio and documents can't draw in this session (${why}) Anything shown with show_image, show_video, show_html, show_audio or show_document was not seen: the person saw a notice instead. Don't say they saw it.`
}
