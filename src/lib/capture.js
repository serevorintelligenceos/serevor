import { supabase } from './supabase.js'
import { invokeFn } from './api.js'

// =====================================================================================
// URL helpers
// =====================================================================================

// Tracking params that identify *who shared* a link (igsh) or add noise. Stripping them
// protects the sender's privacy and lets us detect the same reel saved twice.
const TRACKING_PARAM = /^(utm_.+|igsh|igshid|fbclid|gclid|mc_eid|si|ref_src|ref_url|feature)$/i

const TRAILING_PUNCT = /[.,;:!?)\]}>'"]+$/

// Finds the first link in a piece of text. `loose` also accepts a bare "domain.com/path".
export function findUrl(text, { loose = false } = {}) {
  if (typeof text !== 'string') return null
  const strict = text.match(/https?:\/\/[^\s<>"']+/i)
  if (strict) return strict[0].replace(TRAILING_PUNCT, '')
  if (loose) {
    const t = text.trim()
    if (t && !/\s/.test(t) && /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(t)) {
      return 'https://' + t.replace(TRAILING_PUNCT, '')
    }
  }
  return null
}

// Returns a clean, safe http(s) URL — or null if it isn't one.
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.username = ''
    u.password = ''
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key)
    }
    const out = u.toString()
    return out.length <= 2048 ? out : null
  } catch {
    return null
  }
}

// Only allow http(s) links to be rendered as clickable anchors (blocks javascript: URLs).
export function safeHref(u) {
  return normalizeUrl(typeof u === 'string' ? u : '') ? u : null
}

export function detectPlatform(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\.|^m\./, '').toLowerCase()
    if (h.endsWith('instagram.com')) return 'instagram'
    if (h === 'youtu.be' || h.endsWith('youtube.com')) return 'youtube'
    if (h.endsWith('tiktok.com')) return 'tiktok'
    if (h.endsWith('facebook.com') || h === 'fb.watch') return 'facebook'
    if (h === 'x.com' || h.endsWith('twitter.com')) return 'x'
    if (h.endsWith('linkedin.com')) return 'linkedin'
    if (h.endsWith('reddit.com')) return 'reddit'
    if (h.endsWith('pinterest.com')) return 'pinterest'
    return 'web'
  } catch {
    return 'web'
  }
}

export const PLATFORM_LABEL = {
  instagram: 'Instagram',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  x: 'X',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  pinterest: 'Pinterest',
  web: 'Web',
  'screen-recording': 'Screen recording',
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// =====================================================================================
// Saving
// =====================================================================================

// Creates a knowledge item (status "processing" until the AI has analysed it).
// Links are de-duplicated: saving the same reel twice returns the existing item.
export async function saveCapture(userId, f) {
  if (f.url) {
    const { data: dup } = await supabase
      .from('knowledge_items')
      .select('*')
      .eq('user_id', userId)
      .eq('source_url', f.url)
      .limit(1)
      .maybeSingle()
    if (dup) return { item: dup, duplicate: true }
  }
  const row = {
    user_id: userId,
    source_type: f.sourceType,
    source_url: f.url || null,
    source_platform: f.url ? detectPlatform(f.url) : f.platform || null,
    title: (f.title || 'Untitled').slice(0, 120),
    content: f.content || f.url || '',
    category: 'Uncategorized',
    importance: 1,
    tags: [],
    status: 'processing',
    file_path: f.filePath || null,
    file_type: f.fileType || null,
    source_meta: f.sourceMeta || {},
  }
  const { data, error } = await supabase.from('knowledge_items').insert(row).select('*').single()
  if (error) throw limitError(error) || error
  return { item: data, duplicate: false }
}

// Runs the AI analysis for one item. Returns { item, collection, needs_details, understanding }.
// Parts the user has edited by hand (insights.locked) are never overwritten by the AI.
export function analyzeItem(itemId) {
  return invokeFn('capture-analyze', { item_id: itemId })
}

// =====================================================================================
// Audio: voice notes & screen-recorded reels
// =====================================================================================

export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024 // transcribe function's limit
const ALLOWED_AUDIO_EXT = ['webm', 'm4a', 'mp4', 'mp3', 'mpeg', 'mpga', 'wav', 'ogg', 'flac', 'mov']

export function recordingExt(mime = '') {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

export function pickRecorderMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  if (typeof window === 'undefined' || !window.MediaRecorder) return ''
  return candidates.find((t) => window.MediaRecorder.isTypeSupported?.(t)) || ''
}

function writeStr(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
}

// 16-bit mono PCM WAV
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  writeStr(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(view, 8, 'WAVE')
  writeStr(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let o = 44
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

// Pulls the audio track out of a (possibly large) screen recording and shrinks it to
// 16 kHz mono WAV — a 60 s reel becomes ~2 MB instead of 30+ MB of video.
async function mediaToWav(file, { maxSeconds = 480, sampleRate = 16000 } = {}) {
  const AC = window.AudioContext || window.webkitAudioContext
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!AC || !OAC) throw new Error('unsupported')
  if (file.size > 400 * 1024 * 1024) throw new Error('too-large')
  const bytes = await file.arrayBuffer()
  const ctx = new AC()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(bytes)
  } finally {
    try { await ctx.close() } catch { /* ignore */ }
  }
  const seconds = Math.min(decoded.duration, maxSeconds)
  const offline = new OAC(1, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  return encodeWav(rendered.getChannelData(0), sampleRate)
}

// Uploads audio to the user's private folder, transcribes it, then deletes the audio.
// Only the text is kept — nothing sensitive lingers in storage.
export async function transcribeBlob(userId, blob, ext) {
  const path = `${userId}/tmp/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error: upErr } = await supabase.storage
    .from('knowledge-files')
    .upload(path, blob, { contentType: blob.type || undefined, upsert: false })
  if (upErr) throw new Error('Could not upload the recording: ' + upErr.message)
  try {
    const out = await invokeFn('transcribe', { path })
    return (out?.text || '').trim()
  } finally {
    try { await supabase.storage.from('knowledge-files').remove([path]) } catch { /* best effort */ }
  }
}

// Transcribes a user-picked video/audio file (e.g. a screen-recorded reel).
export async function transcribeMediaFile(userId, file) {
  let wav = null
  try {
    wav = await mediaToWav(file)
  } catch (err) {
    if (err.message === 'too-large') throw new Error('That recording is too large. Trim it to under a few minutes and try again.')
    // Browser couldn't decode it — fall back to sending the original if it's small enough.
  }
  if (wav) return transcribeBlob(userId, wav, 'wav')

  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!ALLOWED_AUDIO_EXT.includes(ext)) throw new Error('Unsupported format. Use mp4, mov, m4a, mp3, wav or webm.')
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Your browser couldn't compress that recording and it's over 24 MB. Try a shorter clip.")
  return transcribeBlob(userId, file, ext)
}

export function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Short, safe file name for storage paths.
export function safeFileName(name) {
  const dot = name.lastIndexOf('.')
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'file'
  const ext = (dot > 0 ? name.slice(dot + 1) : '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()
  return ext ? `${base}.${ext}` : base
}

// =====================================================================================
// Manual control: edit what the AI extracted, organise it your own way
// =====================================================================================

// The AI's own category list. Users can also type any custom category.
export const CATEGORIES = [
  'AI & Tools', 'SEO & Marketing', 'Business Strategy', 'Finance', 'Productivity',
  'Personal Development', 'Learning', 'Tech & Coding', 'Design & Creativity',
  'Health & Fitness', 'Career', 'Lifestyle', 'Uncategorized',
]

export const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [])

// `insights` is JSON; older items may hold an array or nothing, so always read it through here.
export function insightsOf(item) {
  const v = item?.insights
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

export function normalizeTag(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{M}\p{N}_-]/gu, '').slice(0, 30)
}

// Updates columns on one item and returns the fresh row.
export async function patchItem(itemId, fields) {
  const { data, error } = await supabase.from('knowledge_items').update(fields).eq('id', itemId).select('*').single()
  if (error) throw error
  return data
}

// Returns a copy of `insights` with new values, marking those parts as "edited by the user"
// so a later AI re-analysis keeps them.
export function editInsights(current, changes, lockKey) {
  const cur = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const locked = { ...(cur.locked && typeof cur.locked === 'object' ? cur.locked : {}) }
  if (lockKey) locked[lockKey] = true
  return { ...cur, ...changes, locked }
}

export async function fetchCollections(userId) {
  const [{ data: cols, error }, { data: links, error: lErr }] = await Promise.all([
    supabase.from('collections').select('id, name, description, is_auto, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    supabase.from('collection_items').select('collection_id').eq('user_id', userId).limit(2000),
  ])
  if (error) throw error
  if (lErr) throw lErr
  const counts = {}
  for (const l of links || []) counts[l.collection_id] = (counts[l.collection_id] || 0) + 1
  return (cols || []).map((c) => ({ ...c, count: counts[c.id] || 0 })).sort((a, b) => b.count - a.count)
}

export function cleanCollectionName(raw) {
  return String(raw || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

// Creates a folder, or returns the existing one with the same name (case-insensitive).
export async function createCollection(userId, rawName) {
  const name = cleanCollectionName(rawName)
  if (!name) throw new Error('Give the folder a name.')
  const existing = await fetchCollections(userId)
  const same = existing.find((c) => c.name.toLowerCase() === name.toLowerCase())
  if (same) return { collection: same, created: false }
  const { data, error } = await supabase.from('collections').insert({ user_id: userId, name, is_auto: false }).select('id, name, description, is_auto, created_at').single()
  if (error) throw limitError(error) || error
  return { collection: { ...data, count: 0 }, created: true }
}

export async function renameCollection(userId, id, rawName) {
  const name = cleanCollectionName(rawName)
  if (!name) throw new Error('Give the folder a name.')
  const existing = await fetchCollections(userId)
  if (existing.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('You already have a folder with that name.')
  }
  const { data, error } = await supabase.from('collections').update({ name, is_auto: false, updated_at: new Date().toISOString() }).eq('id', id).select('id, name').single()
  if (error) throw error
  return data
}

// Puts an item in / takes it out of a folder.
export async function setItemInCollection(userId, itemId, collectionId, on) {
  if (on) {
    const { error } = await supabase.from('collection_items').upsert(
      { collection_id: collectionId, item_id: itemId, user_id: userId },
      { onConflict: 'collection_id,item_id', ignoreDuplicates: true },
    )
    if (error) throw error
  } else {
    const { error } = await supabase.from('collection_items').delete().eq('collection_id', collectionId).eq('item_id', itemId)
    if (error) throw error
  }
}

// Every tag and category the user has used, for autocomplete.
export async function fetchTagVocabulary(userId) {
  const { data, error } = await supabase.from('knowledge_items').select('tags, category').eq('user_id', userId).order('captured_at', { ascending: false }).limit(500)
  if (error) throw error
  const tagCount = {}
  const cats = new Set()
  for (const r of data || []) {
    for (const t of r.tags || []) tagCount[t] = (tagCount[t] || 0) + 1
    if (r.category) cats.add(r.category)
  }
  const tags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 80)
  return { tags, categories: [...new Set([...CATEGORIES, ...cats])] }
}

// How well Serevor understood an item, for display.
export const UNDERSTANDING_SOURCE = {
  transcript: 'the video transcript',
  captions: 'YouTube captions',
  article: 'the full article',
  notes: 'your notes',
  caption: 'the caption only',
  slides: "the post's images",
  none: 'very little text',
}

// =====================================================================================
// Plan limits (the database is the enforcer; these helpers only explain it nicely)
// =====================================================================================

// Turns the database's `serevor_limit:<name>` errors into an Error with a stable `.code` the UI can act on.
export function limitError(err) {
  const msg = String(err?.message || err || '')
  const m = msg.match(/(?:serevor|nexora)_limit:([a-z_]+)/) // `nexora_` = legacy prefix, accepted until the DB migration is applied
  if (!m) return null
  const name = m[1]
  return Object.assign(
    new Error(
      name === 'capture' ? "You've used today's captures on your plan. Pro raises the daily limit."
        : name === 'collections' ? 'Your plan includes a limited number of folders you create yourself. Pro has unlimited folders.'
          : 'That is the maximum number of folders.',
    ),
    { code: name === 'capture' ? 'limit_capture' : name === 'collections' ? 'limit_collections' : 'limit_collections_max' },
  )
}

// { pro, captures_used, captures_cap, analyses_used, resets_at, folders_used, folders_cap (null = unlimited), max_slides }
// Returns null if it can't be read: callers then simply let the attempt through, because the database enforces anyway.
export async function fetchQuota() {
  try {
    const { data, error } = await supabase.rpc('my_capture_quota')
    if (error || !data || typeof data !== 'object') return null
    return data
  } catch {
    return null
  }
}

export function captureAtLimit(q) {
  return !!q && !q.pro && q.captures_used >= q.captures_cap
}
export function foldersAtLimit(q) {
  return !!q && q.folders_cap != null && q.folders_used >= q.folders_cap
}
// "5h 20m" until the oldest capture of the last 24 hours frees a slot.
export function resetsIn(iso) {
  const ms = new Date(iso).getTime() - Date.now()
  if (!iso || !Number.isFinite(ms) || ms <= 0) return 'soon'
  const mins = Math.ceil(ms / 60000)
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
}

// =====================================================================================
// Posts and carousels: the slides the AI reads
// =====================================================================================

export const MAX_SLIDES = 10 // keep in sync with plans.js, capture-analyze and my_capture_quota()
export const SLIDES_START = "— Text read from the post's images —"
export const SLIDES_END = '— end of image text —'

export function slidePathsOf(item) {
  const sm = item?.source_meta
  const raw = sm && typeof sm === 'object' && Array.isArray(sm.slides) ? sm.slides : []
  return raw.filter((p) => typeof p === 'string' && p)
}

// 'post' (a picture/carousel whose slides can be screenshotted), 'reel' (video), or null.
export function socialKind(url) {
  try {
    const u = new URL(url)
    const h = u.hostname.replace(/^www\.|^m\./, '').toLowerCase()
    const p = u.pathname.toLowerCase()
    if (h.endsWith('instagram.com')) return /\/p\/[\w-]+/.test(p) ? 'post' : /\/(reel|reels|tv)\//.test(p) ? 'reel' : null
    if (h.endsWith('facebook.com') || h === 'fb.watch') return /\/(reel|reels|watch|videos?)\b/.test(p) || h === 'fb.watch' ? 'reel' : p.length > 1 ? 'post' : null
    if (h.endsWith('tiktok.com')) return 'reel'
    if (h.endsWith('linkedin.com')) return /\/(posts|feed\/update)\//.test(p) ? 'post' : null
    if (h === 'x.com' || h.endsWith('twitter.com')) return /\/status\/\d+/.test(p) ? 'post' : null
    if (h.endsWith('pinterest.com')) return /\/pin\//.test(p) ? 'post' : null
    return null
  } catch {
    return null
  }
}

// The AI stores the text it read from the images inside item.content between two marker lines.
// The user edits only their own part, so the block is split off and put back untouched.
export function splitSlideBlock(content) {
  const text = typeof content === 'string' ? content : ''
  const a = text.indexOf(SLIDES_START)
  if (a < 0) return { base: text.trim(), block: '' }
  const b = text.indexOf(SLIDES_END, a)
  const end = b >= 0 ? b + SLIDES_END.length : text.length
  return { base: (text.slice(0, a) + text.slice(end)).trim(), block: text.slice(a, end) }
}

// Uploads prepared images to private storage. All-or-nothing: if one fails, the ones already
// uploaded are removed again so no orphan files are left behind.
export async function uploadSlides(userId, blobs) {
  const stamp = Date.now()
  const paths = []
  try {
    for (let i = 0; i < blobs.length; i++) {
      const path = `${userId}/posts/${stamp}-${i + 1}-${Math.random().toString(36).slice(2, 7)}.jpg`
      const { error } = await supabase.storage.from('knowledge-files').upload(path, blobs[i], { contentType: 'image/jpeg' })
      if (error) throw error
      paths.push(path)
    }
    return paths
  } catch (err) {
    if (paths.length) { try { await supabase.storage.from('knowledge-files').remove(paths) } catch { /* best effort */ } }
    throw err
  }
}

export async function removeStoredFiles(paths) {
  const list = (paths || []).filter(Boolean)
  if (!list.length) return
  try { await supabase.storage.from('knowledge-files').remove(list) } catch { /* best effort */ }
}

// Every file an item owns (slides + a single uploaded file), so deleting the item leaves nothing behind.
export function itemFilePaths(item) {
  return [...new Set([...slidePathsOf(item), item?.file_path].filter(Boolean))]
}

// Short-lived links to show the user's own slides. Returns { [path]: url }.
export async function signedSlideUrls(paths) {
  const list = (paths || []).filter(Boolean)
  if (!list.length) return {}
  try {
    const { data, error } = await supabase.storage.from('knowledge-files').createSignedUrls(list, 3600)
    if (error || !Array.isArray(data)) return {}
    return Object.fromEntries(data.filter((d) => d?.signedUrl && !d.error).map((d) => [d.path, d.signedUrl]))
  } catch {
    return {}
  }
}

// Appends already-uploaded slides to an item (max MAX_SLIDES). Returns the updated row.
export async function attachSlides(item, newPaths) {
  const sm = item.source_meta && typeof item.source_meta === 'object' && !Array.isArray(item.source_meta) ? item.source_meta : {}
  const slides = [...new Set([...slidePathsOf(item), ...newPaths])].slice(0, MAX_SLIDES)
  return patchItem(item.id, { source_meta: { ...sm, slides } })
}

// Slides to show for an item: its uploaded slides, or a single screenshot uploaded the old way.
export function displaySlidePaths(item) {
  const s = slidePathsOf(item)
  if (s.length) return s
  return item?.file_path && /\.(png|jpe?g|webp|gif)$/i.test(item.file_path) ? [item.file_path] : []
}
