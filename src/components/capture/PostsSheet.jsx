import { useEffect, useState } from 'react'
import { X, Images, Clapperboard } from 'lucide-react'
import PostSheet from './PostSheet.jsx'
import ReelSheet from './ReelSheet.jsx'

// One entry point for everything that lives on social media: carousels / image posts and reels / videos.
//   onSavePost({ url, blobs })            -> same contract as PostSheet
//   onSaveRecording({ text, url })        -> same contract as ReelSheet
export default function PostsSheet({ userId, initialTab = 'slides', onClose, onSavePost, onSaveRecording, onPasteClipboard }) {
  const [tab, setTab] = useState(initialTab)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const tabClass = (active) =>
    `flex-1 h-10 rounded-md flex items-center justify-center gap-2 text-body-small font-semibold transition ${
      active ? 'bg-primary/15 text-primary border border-primary/40' : 'text-ink-secondary border border-transparent hover:text-ink-primary'
    }`

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Capture a post">
      <button aria-label="Close" className="absolute inset-0 bg-black/60 cursor-default" onClick={onClose} />
      <div
        className="relative w-full max-w-md lg:max-w-xl max-h-[92vh] overflow-y-auto bg-base-surface border-t border-base-border rounded-t-sheet p-md shadow-card"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
      >
        <div className="flex items-center justify-between mb-sm">
          <h2 className="text-h3 text-ink-primary">Posts</h2>
          <button aria-label="Close" onClick={onClose} className="text-ink-secondary hover:text-ink-primary"><X size={22} /></button>
        </div>

        <div role="tablist" aria-label="Post type" className="flex gap-1 bg-base-elevated border border-base-border rounded-lg p-1 mb-md">
          <button role="tab" aria-selected={tab === 'slides'} onClick={() => setTab('slides')} className={tabClass(tab === 'slides')}>
            <Images size={16} /> Slides
          </button>
          <button role="tab" aria-selected={tab === 'reel'} onClick={() => setTab('reel')} className={tabClass(tab === 'reel')}>
            <Clapperboard size={16} /> Reel / video
          </button>
        </div>

        {tab === 'slides' ? (
          <PostSheet embedded onClose={onClose} onSave={onSavePost} />
        ) : (
          <ReelSheet embedded userId={userId} onClose={onClose} onPasteClipboard={onPasteClipboard} onSaveRecording={onSaveRecording} />
        )}
      </div>
    </div>
  )
}
