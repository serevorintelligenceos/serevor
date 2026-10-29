import { Fragment, useMemo } from 'react'
import { parseMarkdown } from '../../lib/markdown.js'

// Renders AI replies as formatted text. Built from a parsed tree (never innerHTML), so model output cannot inject markup.

function Inline({ nodes }) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <Fragment key={i}>{n.v}</Fragment>
      case 'br': return <br key={i} />
      case 'strong': return <strong key={i} className="font-semibold text-ink-primary"><Inline nodes={n.c} /></strong>
      case 'em': return <em key={i}><Inline nodes={n.c} /></em>
      case 'del': return <del key={i} className="opacity-70"><Inline nodes={n.c} /></del>
      case 'code': return <code key={i} className="font-mono text-[0.9em] bg-base-elevated border border-base-border rounded px-1 py-0.5 break-words">{n.v}</code>
      case 'link': return (
        <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2 break-words hover:opacity-80">
          <Inline nodes={n.c} />
        </a>
      )
      default: return null
    }
  })
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' }

function Table({ b }) {
  return (
    // Wide tables scroll sideways inside their own box instead of squashing columns or breaking the bubble.
    <div className="my-1 overflow-x-auto rounded-lg border border-base-border">
      <table className="min-w-full border-collapse text-body-small">
        <thead className="bg-base-elevated">
          <tr>
            {b.head.map((c, i) => (
              <th key={i} className={`px-3 py-2 font-semibold text-ink-primary align-bottom border-b border-base-border min-w-[5.5rem] ${ALIGN[b.align[i]] || 'text-left'}`}>
                <Inline nodes={c} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((r, ri) => (
            <tr key={ri} className={ri % 2 ? 'bg-base-elevated/40' : ''}>
              {r.map((c, ci) => (
                <td key={ci} className={`px-3 py-2 align-top border-t border-base-border ${ALIGN[b.align[ci]] || 'text-left'}`}>
                  <Inline nodes={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function List({ b }) {
  const Tag = b.t
  return (
    <Tag
      start={b.t === 'ol' && b.start !== 1 ? b.start : undefined}
      className={`${b.t === 'ol' ? 'list-decimal' : 'list-disc'} pl-5 space-y-1 marker:text-ink-tertiary`}
    >
      {b.items.map((it, i) => (
        <li key={i} className="pl-0.5">
          <Inline nodes={it.c} />
          {it.children.map((sub, k) => <div key={k} className="mt-1"><List b={sub} /></div>)}
        </li>
      ))}
    </Tag>
  )
}

const HEADING = {
  1: 'text-h3 font-semibold text-ink-primary',
  2: 'text-body font-semibold text-ink-primary',
  3: 'text-body font-semibold text-ink-primary',
}

function Blocks({ blocks }) {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'p': return <p key={i}><Inline nodes={b.c} /></p>
      case 'h': return <p key={i} role="heading" aria-level={Math.min(b.level + 2, 6)} className={`${HEADING[b.level] || 'text-body-small font-semibold text-ink-secondary uppercase tracking-wide'} pt-1`}><Inline nodes={b.c} /></p>
      case 'ul':
      case 'ol': return <List key={i} b={b} />
      case 'table': return <Table key={i} b={b} />
      case 'code': return (
        <pre key={i} className="overflow-x-auto rounded-lg bg-base-bg border border-base-border px-3 py-2.5 text-caption leading-relaxed font-mono whitespace-pre">
          <code>{b.v}</code>
        </pre>
      )
      case 'quote': return (
        <blockquote key={i} className="border-l-2 border-base-border pl-3 text-ink-secondary space-y-2">
          <Blocks blocks={b.blocks} />
        </blockquote>
      )
      case 'hr': return <hr key={i} className="border-base-border" />
      default: return null
    }
  })
}

export default function Markdown({ text }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="space-y-2.5 break-words [&>*:first-child]:mt-0">
      <Blocks blocks={blocks} />
    </div>
  )
}
