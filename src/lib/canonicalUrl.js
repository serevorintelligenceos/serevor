// Pure helper (no imports): one canonical form per piece of content, so the same reel or video saved from
// different share links is recognised as ONE item (no duplicate rows, no second AI analysis, no second provider call).
// Mirrors supabase/functions/smart-capture/platforms.ts. Unknown links are returned untouched.
const IG_CODE = /^[A-Za-z0-9_-]{5,30}$/
const YT_ID = /^[A-Za-z0-9_-]{11}$/

export function canonicalContentUrl(u) {
  try {
    const host = u.hostname.replace(/^www\.|^m\./i, '').toLowerCase()
    const seg = u.pathname.split('/').filter(Boolean)
    if (host === 'instagram.com' || host === 'instagr.am') {
      const i = seg.findIndex((s) => ['p', 'reel', 'reels', 'tv'].includes(s.toLowerCase()))
      const code = i >= 0 ? seg[i + 1] : undefined
      if (i >= 0 && i <= 1 && code && IG_CODE.test(code)) {
        return `https://www.instagram.com/${seg[i].toLowerCase() === 'p' ? 'p' : 'reel'}/${code}/`
      }
    }
    if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
      let id = null
      if (host === 'youtu.be') id = seg[0] || null
      else if (seg[0] === 'watch') id = u.searchParams.get('v')
      else if (['shorts', 'embed', 'live', 'v'].includes(seg[0] || '')) id = seg[1] || null
      if (id && YT_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`
    }
  } catch { /* fall through */ }
  return null
}
