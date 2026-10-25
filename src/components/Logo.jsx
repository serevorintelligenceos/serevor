import { useId } from 'react'
import bodyUrl from '../assets/brand/serevor-body.png?inline'
import planetUrl from '../assets/brand/serevor-planet.png?inline'
import starUrl from '../assets/brand/serevor-star.png?inline'

// Serevor brand mark (orbital "S" + orbit ring + planet + star), drawn from the official artwork.
// The artwork is split into three transparent layers so the loader can animate the planet and star:
//   body   -> S ribbons + orbit ring      planet -> small sphere      star -> 4-point star + glow
// Layers are inlined as data URIs (`?inline`): no network request, so the loader never flashes empty.
// All coordinates below are in the artwork's own pixel space; the viewBox just chooses the crop.
//
// variant="tile"  → mark on the navy app-icon tile. Looks identical in dark and light mode (default).
// variant="mark"  → bare mark on a transparent background. The star is white, so use it on DARK surfaces only.
const LAYERS = {
  body: { url: bodyUrl, x: 321, y: 367, w: 635, h: 526 },
  planet: { url: planetUrl, x: 788, y: 351, w: 101, h: 102, className: 'nx-planet' },
  star: { url: starUrl, x: 516, y: 521, w: 204, h: 197, className: 'nx-star' },
}

const TILE = { x: 167, y: 151, s: 942 } // square crop of the artwork that becomes the tile
const BARE = { x: 308, y: 292, s: 660 } // square crop around the bare mark

const BODY = () => (
  <>
    {Object.entries(LAYERS).map(([name, l]) => (
      <image key={name} className={l.className} href={l.url} x={l.x} y={l.y} width={l.w} height={l.h} />
    ))}
  </>
)

export default function Logo({ size = 40, variant = 'tile', animated = false, className = '', title = 'Serevor' }) {
  const id = 'sv' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const tile = variant === 'tile'
  const v = tile ? TILE : BARE
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${v.x} ${v.y} ${v.s} ${v.s}`}
      role="img"
      aria-label={title}
      className={`nx-logo ${animated ? 'nx-logo-anim' : ''} ${tile ? '' : 'nx-logo-bare'} ${className}`}
      style={{ display: 'block', flexShrink: 0 }}
    >
      {tile && (
        <>
          <defs>
            <linearGradient id={`${id}bg`} gradientUnits="userSpaceOnUse" x1={TILE.x} y1={TILE.y + TILE.s} x2={TILE.x + TILE.s} y2={TILE.y}>
              <stop offset="0" stopColor="#00000C" />
              <stop offset="1" stopColor="#02041E" />
            </linearGradient>
          </defs>
          <rect x={TILE.x} y={TILE.y} width={TILE.s} height={TILE.s} rx={TILE.s * 0.2246} fill={`url(#${id}bg)`} />
        </>
      )}
      <BODY />
    </svg>
  )
}

// Full-screen loading screen. Uses only transform/opacity animations (GPU-friendly, no layout work).
export function LogoLoader({ size = 96, label }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-base-bg" role="status" aria-live="polite" aria-label={label || 'Loading Serevor'}>
      <Logo size={size} animated />
      {label && <p className="text-body-small text-ink-secondary mt-md">{label}</p>}
    </div>
  )
}
