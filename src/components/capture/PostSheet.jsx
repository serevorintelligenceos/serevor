import { useEffect, useRef, useState } from 'react'
import { X, Images, Link2, Loader2, Sparkles, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { findUrl, normalizeUrl, MAX_SLIDES } from '../../lib/capture.js'
import { prepareImage } from '../../lib/images.js'

// Capture a post or carousel: add a screenshot of every slide (in order) and, optionally, the post's link.
// Serevor reads the text and visuals of every slide, so the knowledge inside the post is captured, not just its caption.
//   onSave({ url, blobs }) -> Promise; should throw on failure (the sheet then stays open)
export default function PostSheet({ onClose, onSave }) {
  const [url, setUrl] = useState('')
  const [slides, setSlides] = useState([]) // [{ id, blob, preview }]
  const [preparing, setPreparing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  const slidesRef = useRef(slides)
  slidesRef.current = slides

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
      slidesRef.current.forEach((s) => URL.revokeObjectURL(s.preview))
    }
  }, [onClose])

  async function addFiles(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    setError('')
    const room = MAX_SLIDES - slides.length
    if (room <= 0) { setError(`A post can have up to ${MAX_SLIDES} slides.`); return }
    const take = files.slice(0, room)
    setPreparing(true)
    const added = []
    const problems = []
    for (const f of take) {
      try {
        const blob = await prepareImage(f)
        added.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, blob, preview: URL.createObjectURL(blob) })
      } catch (err) {
        problems.push(err.message)
      }
    }
    setSlides((prev) => [...prev, ...added])
    setPreparing(false)
    const msgs = [...problems]
    if (files.length > room) msgs.push(`Only the first ${room} image${room === 1 ? '' : 's'} were added (limit ${MAX_SLIDES} slides).`)
    if (msgs.length) setError(msgs.join(' '))
  }

  function move(i, dir) {
    setSlides((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function remove(i) {
    setSlides((prev) => {
      URL.revokeObjectURL(prev[i].preview)
      return prev.filter((_, idx) => idx !== i)
    })
  }

  async function handleSave() {
    if (saving || preparing) return
    setError('')
    let link = null
    if (url.trim()) {
      link = normalizeUrl(findUrl(url, { loose: true }) || '')
      if (!link) { setError("That link doesn't look valid. It should start with https://"); return }
    }
    if (!link && slides.length === 0) { setError('Add the slide screenshots or paste the post link.'); return }
    setSaving(true)
    try {
      await onSave({ url: link, blobs: slides.map((s) => s.blob) })
    } catch (err) {
      setError(err.message || 'Could not save this post.')
    } finally {
      setSaving(false)
    }
  }

  const busy = saving || preparing

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Capture a post">
      <button aria-label="Close" className="absolute inset-0 bg-black/60 cursor-default" onClick={onClose} />
      <div
        className="relative w-full max-w-md lg:max-w-xl max-h-[92vh] overflow-y-auto bg-base-surface border-t border-base-border rounded-t-sheet p-md shadow-card"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
      >
        <div className="flex items-center justify-between mb-sm">
          <h2 className="text-h3 text-ink-primary">Capture a post</h2>
          <button aria-label="Close" onClick={onClose} className="text-ink-secondary hover:text-ink-primary"><X size={22} /></button>
        </div>
        <p className="text-body-small text-ink-secondary mb-md leading-relaxed">
          The knowledge in a post lives in its slides. Screenshot <b>every slide in order</b> (swipe, screenshot, repeat), then select them all here. Serevor reads every slide and pulls out the tips, steps, tools and links.
        </p>

        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={addFiles} />

        <div className="grid grid-cols-3 gap-2 mb-sm" data-testid="slide-grid">
          {slides.map((s, i) => (
            <div key={s.id} className="relative aspect-[3/4] rounded-card overflow-hidden border border-base-border bg-base-elevated">
              <img src={s.preview} alt={`Slide ${i + 1}`} className="w-full h-full object-cover" />
              <span className="absolute top-1 left-1 text-[10px] font-semibold bg-black/70 text-white rounded px-1.5 py-0.5">{i + 1}</span>
              <button aria-label={`Remove slide ${i + 1}`} onClick={() => remove(i)} disabled={busy} className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center disabled:opacity-50">
                <X size={13} />
              </button>
              <div className="absolute bottom-1 inset-x-1 flex justify-between">
                <button aria-label={`Move slide ${i + 1} earlier`} onClick={() => move(i, -1)} disabled={busy || i === 0} className="w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center disabled:opacity-30">
                  <ChevronLeft size={14} />
                </button>
                <button aria-label={`Move slide ${i + 1} later`} onClick={() => move(i, 1)} disabled={busy || i === slides.length - 1} className="w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center disabled:opacity-30">
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          ))}
          {slides.length < MAX_SLIDES && (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="aspect-[3/4] rounded-card border-2 border-dashed border-base-border text-ink-secondary hover:text-primary hover:border-primary/60 flex flex-col items-center justify-center gap-1 transition disabled:opacity-60"
            >
              {preparing ? <Loader2 size={22} className="animate-spin" /> : slides.length ? <Plus size={22} /> : <Images size={24} />}
              <span className="text-caption font-semibold px-1 text-center">{preparing ? 'Preparing…' : slides.length ? 'Add more' : 'Add slides'}</span>
            </button>
          )}
        </div>
        <p className="text-caption text-ink-tertiary mb-md">{slides.length} of {MAX_SLIDES} slides{slides.length > 1 ? ' · use the arrows to fix the order' : ''}</p>

        <div className="input-glow bg-base-elevated border border-base-border rounded-input flex items-center px-md py-3 gap-2 transition mb-md">
          <Link2 size={18} className="text-ink-secondary shrink-0" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value.slice(0, 2048))}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Post link (optional)"
            placeholder="Post link (optional)"
            className="bg-transparent w-full text-body text-ink-primary placeholder:text-ink-tertiary focus:outline-none"
          />
        </div>

        {error && <p className="text-caption text-error mb-sm" role="alert">{error}</p>}

        <button
          onClick={handleSave}
          disabled={busy || (!slides.length && !url.trim())}
          className="btn-primary w-full h-12 flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
          {saving ? 'Uploading…' : 'Save & analyze'}
        </button>
      </div>
    </div>
  )
}
