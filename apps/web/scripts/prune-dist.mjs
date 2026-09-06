// Prune stale Vite build output. With emptyOutDir:false the assets dir keeps
// hashed chunks from previous builds so already-open tabs never 404 — but
// without a cleanup the folder grows unbounded. Hashed chunks are immutable,
// so anything not touched by a recent build is safe to remove.
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const assets = join(process.cwd(), 'dist', 'assets')
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const cutoff = Date.now() - KEEP_MS

let pruned = 0
for (const f of readdirSync(assets)) {
  const p = join(assets, f)
  try {
    if (statSync(p).mtimeMs < cutoff) {
      unlinkSync(p)
      pruned += 1
      console.log(`pruned stale asset: ${f}`)
    }
  } catch { /* already gone */ }
}
if (pruned === 0) console.log('no stale assets to prune')