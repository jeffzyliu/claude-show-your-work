import { expect, test } from 'claude-code/testing'

const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
const use = (props: object, requestId = 'tu-1') => ({
  plugin: 'show-your-work', surface: 'terminal', component: 'ToolUse', requestId,
  props: { tool_use_id: requestId, input: {}, isRunning: false, isErrored: false, isInterrupted: false, ...props },
  viewport: { columns: 100, rows: 40 },
}) as any

test('this plugin\'s own call row is a green bullet, the bold tool name, then the details', async $ => {
  const tree = JSON.stringify(await (await $.ui.mount(use({ tool: 'mcp__show-your-work__show_image', input: { path: '/a/shot.png' } }))).drawn())

  expect(tree).toContain('⏺')
  expect(tree).toContain('"green"')
  expect(tree).toContain('show_image')
  expect(tree).toContain(' - shot.png')
})

test('a running call\'s bullet is dim, a failed one\'s red', async $ => {
  const running = JSON.stringify(await (await $.ui.mount(use({ tool: 'mcp__show-your-work__show_image', isRunning: true }, 'r'))).drawn())
  const failed = JSON.stringify(await (await $.ui.mount(use({ tool: 'mcp__show-your-work__show_image', isErrored: true }, 'f'))).drawn())

  expect(running).toContain('"dimColor":true')
  expect(failed).toContain('"red"')
})

test('a folded group is unfolded only when it mixes a picture call with other calls', async ($, on) => {
  const seen = new Map<string, unknown>()
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    seen.set(e.requestId, e.props.isExpanded)

    return next(e)
  })
  const group = (calls: object[], requestId: string) => ({
    plugin: 'show-your-work', surface: 'terminal', component: 'ToolGroup', requestId,
    props: { calls, isActive: false, isExpanded: false }, viewport: { columns: 100, rows: 40 },
  }) as any
  const call = (tool: string, output: unknown, id: string) => ({ tool, tool_use_id: id, input: {}, isRunning: false, isErrored: false, isInterrupted: false, output })
  await (await $.ui.mount(group([call('mcp__dofile__run_do', [png], 'a'), call('Read', 'text', 'b')], 'g1'))).drawn()
  await (await $.ui.mount(group([call('Read', 'text', 'c')], 'g2'))).drawn()
  await (await $.ui.mount(group([{ ...call('mcp__dofile__run_do', [png], 'd'), isErrored: true }], 'g3'))).drawn()

  expect(seen.get('g1')).toBe(true)
  expect(seen.get('g2')).toBe(false)
  expect(seen.get('g3')).toBe(false)
})

test('a call with no picture, or one that failed, keeps the engine\'s own row', async $ => {
  const plain = JSON.stringify(await (await $.ui.mount(use({ tool: 'mcp__dofile__run_do', output: [{ type: 'text', text: 'ok' }] }, 'p'))).drawn())
  const failed = JSON.stringify(await (await $.ui.mount(use({ tool: 'mcp__dofile__run_do', isErrored: true, output: [png] }, 'e'))).drawn())

  expect(plain).not.toContain('dofile - run_do')
  expect(failed).not.toContain('dofile - run_do')
})
