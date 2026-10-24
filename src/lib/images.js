// Prepares a screenshot / photo for upload and AI reading.
// Long side <= 2400px keeps a 1080x2400 phone screenshot at full size, so small text stays legible; the JPEG
// is then squeezed until it is small enough that three of them fit in one AI request.
export const MAX_IMAGE_SIDE = 2400
export const MAX_PREPARED_BYTES = 750 * 1024
const MAX_INPUT_BYTES = 30 * 1024 * 1024

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file) } catch { /* fall back to <img> below */ }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error("We couldn't open that image."))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))

// Returns a JPEG Blob. Throws a user-readable Error for anything that is not a usable image.
export async function prepareImage(file) {
  if (!file || !/^image\//i.test(file.type || '')) throw new Error(`"${file?.name || 'That file'}" is not an image.`)
  if (file.size > MAX_INPUT_BYTES) throw new Error(`"${file.name}" is too large (over 30 MB).`)
  const src = await decodeImage(file)
  const sw = src.width, sh = src.height
  if (!sw || !sh) throw new Error(`"${file.name}" looks empty.`)
  let scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let blob = null
  for (let attempt = 0; attempt < 6; attempt++) {
    canvas.width = Math.max(1, Math.round(sw * scale))
    canvas.height = Math.max(1, Math.round(sh * scale))
    ctx.fillStyle = '#ffffff' // transparent PNGs would otherwise turn black as JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
    for (const q of [0.86, 0.74, 0.62]) {
      blob = await toBlob(canvas, q)
      if (blob && blob.size <= MAX_PREPARED_BYTES) break
    }
    if (blob && blob.size <= MAX_PREPARED_BYTES) break
    scale *= 0.85
  }
  src.close?.()
  if (!blob) throw new Error(`"${file.name}" could not be prepared.`)
  return blob
}
