/**
 * Vision-model discovery and selection for the read-image subagent.
 *
 * `discoverVisionModels` walks the live LLM directory and collects every model
 * that declares image input (provider adapters advertise `inputModalities`),
 * so the plugin "sees" whichever vision models the deployment actually serves
 * — official DeepSeek, Trae, opencode-go, GLM, any extra provider — without
 * hardcoding a list. The deployment's own model configuration stays the single
 * source of truth: a vision model is simply a model whose route declares
 * `input: [text, image]`.
 *
 * `selectVisionModel` picks the model for one read-image subagent:
 * - `mode: 'auto'` — merge explicit `candidates` (which may attach `free` /
 *   `quality` metadata) with discovered models, keep only routes that are
 *   actually registered, then order **free first, then by quality**.
 * - `mode: 'manual'` — use the explicit `manual.provider` / `manual.model`.
 *
 * Free-ness is judged, in priority order: an explicit `candidates.free` flag,
 * then membership in `freeProviders` (e.g. a locally hosted free route like
 * trae-solo), then a name heuristic (flash / free / lite / mini / …).
 */
import type { Context } from '@deepseek-ai/cordis'

export interface VisionModelCandidate {
  provider: string
  model: string
  name?: string
  /** Free tier first. */
  free: boolean
  /** 1..5, higher = better quality (default 3). */
  quality: number
}

export interface ModelSelectionConfig {
  /** `auto` = discover + rank (free first, then quality); `manual` = explicit route. */
  mode: 'auto' | 'manual'
  /** Provider routes whose vision models are all considered free (e.g. `trae-solo`). */
  freeProviders: string[]
  /** Optional explicit vision models with free/quality metadata, merged with discovery. */
  candidates: Array<{
    provider: string
    model: string
    free?: boolean
    quality?: number
  }>
  /** Explicit route used when `mode: 'manual'`. */
  manual: {
    provider: string
    model?: string
  }
}

const FREE_HINTS = ['flash', 'free', 'lite', 'mini', 'light', '免费', 'fast'] as const

function guessFree(name: string): boolean {
  const hay = name.toLowerCase()
  return FREE_HINTS.some((hint) => hay.includes(hint))
}

/** Models whose provider adapter declares image input, as discovery candidates. */
export async function discoverVisionModels(ctx: Context): Promise<VisionModelCandidate[]> {
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return []
  }
  const out: VisionModelCandidate[] = []
  for (const provider of providers) {
    let models
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue // one broken catalog must not kill discovery
    }
    for (const model of models) {
      if (model.inputModalities !== undefined && model.inputModalities.includes('image')) {
        const label = model.name ?? model.id
        out.push({
          provider: provider.id,
          model: model.id,
          name: label,
          free: guessFree(label),
          quality: 3,
        })
      }
    }
  }
  return out
}

export interface SelectedVisionRoute {
  provider: string
  model?: string
}

/**
 * Resolve the full ordered list of vision routes a read-image subagent may use,
 * best first. `mode: 'manual'` yields at most the one explicit route; `auto`
 * yields every usable discovered/candidate route sorted free-first, then by
 * quality. Returns an empty list only when nothing usable is available (the
 * caller then degrades to a transcription-failure placeholder). Callers may
 * walk the list for retry-after-failure instead of giving up on the best route.
 */
export async function selectVisionModelCandidates(
  ctx: Context,
  config: ModelSelectionConfig,
): Promise<SelectedVisionRoute[]> {
  if (config.mode === 'manual') {
    return config.manual.provider.length > 0
      ? [{ provider: config.manual.provider, ...(config.manual.model?.length ? { model: config.manual.model } : {}) }]
      : []
  }

  // Auto: configured candidates + discovery, deduped (candidate metadata wins).
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  let registered: ReadonlySet<string>
  try {
    registered = new Set(llm.listProviders().map((p) => p.id))
  } catch {
    registered = new Set()
  }

  const byKey = new Map<string, VisionModelCandidate>()
  const freeProviders = new Set(config.freeProviders)
  for (const c of config.candidates) {
    byKey.set(`${c.provider}/${c.model}`, {
      provider: c.provider,
      model: c.model,
      free: c.free ?? freeProviders.has(c.provider) ?? guessFree(c.model),
      quality: c.quality ?? 3,
    })
  }
  for (const found of await discoverVisionModels(ctx)) {
    const label = `${found.provider}/${found.model}`
    if (byKey.has(label)) continue
    byKey.set(label, {
      ...found,
      free: freeProviders.has(found.provider) || found.free,
    })
  }

  const usable = [...byKey.values()].filter((c) => registered.has(c.provider))
  usable.sort(
    (a, b) =>
      Number(b.free) - Number(a.free) ||
      b.quality - a.quality ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  )
  return usable.map((c) => ({ provider: c.provider, model: c.model }))
}

/**
 * Resolve the best vision route for one read-image subagent.
 * Returns `undefined` only when nothing usable is available (the caller then
 * degrades to a transcription-failure placeholder).
 */
export async function selectVisionModel(
  ctx: Context,
  config: ModelSelectionConfig,
): Promise<SelectedVisionRoute | undefined> {
  return (await selectVisionModelCandidates(ctx, config))[0]
}
