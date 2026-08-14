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
import type { Context } from '@deepseek-ai/cordis';
export interface VisionModelCandidate {
    provider: string;
    model: string;
    name?: string;
    /** Free tier first. */
    free: boolean;
    /** 1..5, higher = better quality (default 3). */
    quality: number;
}
export interface ModelSelectionConfig {
    /** `auto` = discover + rank (free first, then quality); `manual` = explicit route. */
    mode: 'auto' | 'manual';
    /** Provider routes whose vision models are all considered free (e.g. `trae-solo`). */
    freeProviders: string[];
    /** Optional explicit vision models with free/quality metadata, merged with discovery. */
    candidates: Array<{
        provider: string;
        model: string;
        free?: boolean;
        quality?: number;
    }>;
    /** Explicit route used when `mode: 'manual'`. */
    manual: {
        provider: string;
        model?: string;
    };
}
/** Models whose provider adapter declares image input, as discovery candidates. */
export declare function discoverVisionModels(ctx: Context): Promise<VisionModelCandidate[]>;
export interface SelectedVisionRoute {
    provider: string;
    model?: string;
}
/**
 * Resolve the full ordered list of vision routes a read-image subagent may use,
 * best first. `mode: 'manual'` yields at most the one explicit route; `auto`
 * yields every usable discovered/candidate route sorted free-first, then by
 * quality. Returns an empty list only when nothing usable is available (the
 * caller then degrades to a transcription-failure placeholder). Callers may
 * walk the list for retry-after-failure instead of giving up on the best route.
 */
export declare function selectVisionModelCandidates(ctx: Context, config: ModelSelectionConfig): Promise<SelectedVisionRoute[]>;
/**
 * Resolve the best vision route for one read-image subagent.
 * Returns `undefined` only when nothing usable is available (the caller then
 * degrades to a transcription-failure placeholder).
 */
export declare function selectVisionModel(ctx: Context, config: ModelSelectionConfig): Promise<SelectedVisionRoute | undefined>;
