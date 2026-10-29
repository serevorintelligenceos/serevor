// Small, dependency-free Markdown parser for AI replies. It produces a plain data tree (no HTML strings), and the
// <Markdown/> component turns that into React elements, so model output can never inject HTML or scripts.
// Handles: paragraphs, headings, bold / italic / strikethrough, inline code, fenced code, bullet + numbered lists
// (nested), blockquotes, horizontal rules, links, and GFM tables (including slightly broken ones).

// ---------------------------------------------------------------------------------------------- inline

const isAlnum = (ch) => !!ch && /[A-Za-z0-9]/.test(ch)
const isSpace = (ch) => !ch || /\s/.test(ch)
const LINK_RE = /^\[([^\]\n]+)\]\(\s*(https?:\/\/[^\s)]+|mailto:[^\s)]+)(?:\s+"[^"]*")?\s*\)/
const URL_RE = /^https?:\/\/[^\s<>]+/
const BR_RE = /^<br\s*\/?>/i

function pushText(out, s) {
  if (!s) return
  const last = out[out.length - 1]
  if (last && last.t === 'text') last.v += s
  else out.push({ t: 'text', v: s })
}

// Finds the closing `marker` for an opener at `from`, skipping inline-code spans. Returns -1 if none.
function findClose(src, marker, from, { wordBoundary = false } = {}) {
  let j = from
  while (j < src.length) {
    if (src[j] === '`') {
      const run = /^`+/.exec(src.slice(j))[0]
      const end = src.indexOf(run, j + run.length)
      j = end === -1 ? j + run.length : end + run.length
      continue
    }
    if (src[j] === '\\') { j += 2; continue }
    if (src.startsWith(marker, j)) {
      const prev = src[j - 1]
      const next = src[j + marker.length]
      const single = marker.length === 1
      // a lone * or _ must not be part of a longer run (** / __)
      if (single && (src[j + 1] === marker || prev === marker)) { j += 1; continue }
      if (!isSpace(prev) && (!wordBoundary || !isAlnum(next))) return j
    }
    j += 1
  }
  return -1
}

export function parseInline(src) {
  const out = []
  let i = 0
  let buf = ''
  const flush = () => { pushText(out, buf); buf = '' }
  while (i < src.length) {
    const ch = src[i]
    const rest = src.slice(i)

    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!|~>]/.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue }
    if (ch === '\n') { flush(); out.push({ t: 'br' }); i += 1; continue }
    if (ch === '<') { const m = BR_RE.exec(rest); if (m) { flush(); out.push({ t: 'br' }); i += m[0].length; continue } }

    if (ch === '`') {
      const run = /^`+/.exec(rest)[0]
      const end = src.indexOf(run, i + run.length)
      if (end !== -1) {
        flush()
        out.push({ t: 'code', v: src.slice(i + run.length, end).replace(/^ (.*) $/, '$1') })
        i = end + run.length
        continue
      }
      buf += run; i += run.length; continue
    }

    if (ch === '[') {
      const m = LINK_RE.exec(rest)
      if (m) { flush(); out.push({ t: 'link', href: m[2], c: parseInline(m[1]) }); i += m[0].length; continue }
    }
    if (ch === 'h' && !isAlnum(src[i - 1])) {
      const m = URL_RE.exec(rest)
      if (m) {
        const url = m[0].replace(/[.,;:!?'")\]]+$/, '')
        flush(); out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] }); i += url.length; continue
      }
    }

    // emphasis: ***x***, **x**, __x__, ~~x~~, *x*, _x_
    const tryWrap = (marker, type, opts) => {
      if (!src.startsWith(marker, i)) return false
      if (marker === '_' || marker === '__') { if (isAlnum(src[i - 1])) return false }
      const after = src[i + marker.length]
      if (isSpace(after)) return false
      const j = findClose(src, marker, i + marker.length, opts)
      if (j === -1 || j === i + marker.length) return false
      flush()
      out.push({ t: type, c: parseInline(src.slice(i + marker.length, j)) })
      i = j + marker.length
      return true
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      if (src.startsWith('***', i)) {
        const j = findClose(src, '***', i + 3)
        if (j > i + 3 && !isSpace(src[i + 3])) { flush(); out.push({ t: 'strong', c: [{ t: 'em', c: parseInline(src.slice(i + 3, j)) }] }); i = j + 3; continue }
      }
      if (tryWrap('**', 'strong') || tryWrap('__', 'strong', { wordBoundary: true }) || tryWrap('~~', 'del')) continue
      if (tryWrap('*', 'em') || tryWrap('_', 'em', { wordBoundary: true })) continue
    }

    buf += ch
    i += 1
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------------------------- blocks

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE_RE = /^\s{0,3}>\s?/
const ITEM_RE = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/
const SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

const hasPipe = (l) => l.includes('|')
const isSeparator = (l) => l != null && SEP_RE.test(l) && l.includes('-') && (l.includes('|') || /^\s*:?-{3,}:?\s*$/.test(l) === false)
const startsEndsPipe = (l) => { const t = l.trim(); return t.length > 1 && t.startsWith('|') && t.endsWith('|') }

// Is a table starting at lines[i]? (a proper header + separator, or two+ consecutive |pipe| rows)
function isTableStart(lines, i) {
  const l = lines[i]
  if (l == null || !hasPipe(l)) return false
  if (isSeparator(lines[i + 1]) && hasPipe(lines[i + 1])) return true
  return startsEndsPipe(l) && lines[i + 1] != null && startsEndsPipe(lines[i + 1])
}

function splitRow(line) {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++ }
    else if (t[i] === '`') { // keep pipes inside inline code
      const end = t.indexOf('`', i + 1)
      if (end === -1) cur += t[i]
      else { cur += t.slice(i, end + 1).replace(/\\\|/g, '|'); i = end }
    } else if (t[i] === '|') { cells.push(cur.trim()); cur = '' }
    else cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

const alignOf = (cell) => {
  const c = cell.trim()
  if (c.startsWith(':') && c.endsWith(':')) return 'center'
  if (c.endsWith(':')) return 'right'
  return 'left'
}

function parseTable(lines, i) {
  const header = splitRow(lines[i])
  let j = i + 1
  let align = header.map(() => 'left')
  if (isSeparator(lines[j]) && hasPipe(lines[j])) {
    const seps = splitRow(lines[j])
    align = header.map((_, k) => alignOf(seps[k] || ''))
    j += 1
  }
  const rows = []
  while (j < lines.length && lines[j].trim() !== '' && hasPipe(lines[j]) && !isSeparator(lines[j])) {
    rows.push(splitRow(lines[j]))
    j += 1
  }
  // Normalise every row to the header's column count (models often emit ragged rows)
  const cols = Math.max(1, header.length)
  const fit = (r) => { const x = r.slice(0, cols); while (x.length < cols) x.push(''); return x }
  return {
    next: j,
    block: {
      t: 'table',
      align,
      head: fit(header).map((c) => parseInline(c)),
      rows: rows.map((r) => fit(r).map((c) => parseInline(c))),
    },
  }
}

const indentOf = (s) => s.replace(/\t/g, '  ').length - s.replace(/\t/g, '  ').trimStart().length

function parseList(lines, i) {
  const first = ITEM_RE.exec(lines[i])
  const makeList = (marker) => ({ t: /\d/.test(marker) ? 'ol' : 'ul', start: /\d/.test(marker) ? parseInt(marker, 10) : 1, items: [] })
  const root = makeList(first[2])
  const stack = [{ indent: indentOf(first[1]), list: root }]
  let j = i
  while (j < lines.length) {
    const line = lines[j]
    const m = ITEM_RE.exec(line)
    if (line.trim() === '') {
      // a blank line continues the list only if another item / indented text follows
      let k = j + 1
      while (k < lines.length && lines[k].trim() === '') k++
      if (k < lines.length && (ITEM_RE.test(lines[k]) || indentOf(lines[k]) >= 2) && !HEADING_RE.test(lines[k]) && !isTableStart(lines, k)) { j = k; continue }
      break
    }
    if (m && !HR_RE.test(line)) {
      const n = indentOf(m[1])
      while (stack.length > 1 && n < stack[stack.length - 1].indent) stack.pop()
      let top = stack[stack.length - 1]
      if (n > top.indent && top.list.items.length) {
        const sub = makeList(m[2])
        top.list.items[top.list.items.length - 1].children.push(sub)
        top = { indent: n, list: sub }
        stack.push(top)
      }
      top.list.items.push({ text: m[3], children: [] })
      j += 1
      continue
    }
    // continuation line of the previous item (indented), otherwise the list ends
    if (indentOf(line) >= 2 && !FENCE_RE.test(line) && !isTableStart(lines, j)) {
      const top = stack[stack.length - 1].list
      const item = top.items[top.items.length - 1]
      item.text += '\n' + line.trim()
      j += 1
      continue
    }
    break
  }
  const finish = (list) => ({
    t: list.t,
    start: list.start,
    items: list.items.map((it) => ({ c: parseInline(it.text), children: it.children.map(finish) })),
  })
  return { next: j, block: finish(root) }
}

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i += 1; continue }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const mark = fence[1][0]
      const body = []
      i += 1
      while (i < lines.length && !new RegExp('^\\s{0,3}\\' + mark + '{' + fence[1].length + ',}\\s*$').test(lines[i])) { body.push(lines[i]); i += 1 }
      i += 1 // closing fence (or end of text if the model never closed it)
      blocks.push({ t: 'code', lang: fence[2] || '', v: body.join('\n') })
      continue
    }
    const h = HEADING_RE.exec(line)
    if (h) { blocks.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) }); i += 1; continue }
    if (HR_RE.test(line)) { blocks.push({ t: 'hr' }); i += 1; continue }
    if (isTableStart(lines, i)) { const r = parseTable(lines, i); blocks.push(r.block); i = r.next; continue }
    if (QUOTE_RE.test(line)) {
      const inner = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) { inner.push(lines[i].replace(QUOTE_RE, '')); i += 1 }
      blocks.push({ t: 'quote', blocks: parseMarkdown(inner.join('\n')) })
      continue
    }
    if (ITEM_RE.test(line)) { const r = parseList(lines, i); blocks.push(r.block); i = r.next; continue }

    // paragraph: runs until a blank line or the start of another block
    const para = []
    while (i < lines.length && lines[i].trim() !== '') {
      const l = lines[i]
      if (para.length && (FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || ITEM_RE.test(l) || isTableStart(lines, i))) break
      para.push(l.trim())
      i += 1
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) })
  }
  return blocks
}
