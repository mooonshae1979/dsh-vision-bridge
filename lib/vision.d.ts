/**
 * The vision bridge eye: when a step's input carries images on a route whose
 * model does not natively see — any text model (official DeepSeek, Trae,
 * opencode-go text models, ...) — dispatch a one-shot read-image subagent
 * whose `agentOptions` pin the auto-discovered vision route (free first,
 * quality first). The subagent transcribes the images into exact text and we
 * hand the rewritten (image-free) input to the main model so it keeps doing
 * the actual work. The transcription is model-visible and lands in the
 * durable session log through the loop's normal entered-message path.
 *
 * A model that natively sees (declares image input — e.g. opencode-go's
 * mimo-v2.5 / qwen3.6-plus) is never rewritten. The read-image subagent runs
 * on one of those models, which is also what prevents recursion: its own
 * pre-step sees a native vision model and leaves it alone.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelectionConfig } from './models.js';
export interface VisionSettings {
    /** Auto-discovery / ranking rules for the read-image subagent's model. */
    modelSelection: ModelSelectionConfig;
    /** Transcription instruction shown to the vision model. */
    transcribePrompt: string;
    /** Abort one transcription attempt after this many ms. */
    transcribeTimeoutMs: number;
    /** How many vision routes to try (best first) before giving up (>= 1). */
    maxAttempts: number;
    /** When every subagent attempt fails, retry once through a direct llm.stream call (default true). */
    fallbackToDirect: boolean;
    /** Include image source info (name / attachmentId / stored object path) in failure placeholders (default true). */
    includeAttachmentInfo: boolean;
    /** Pass the user's own text (question/instruction) from the same message to the vision model, so it reads the image with the user's intent in mind (default true). */
    includeUserText: boolean;
}
export declare const DEFAULT_TRANSCRIBE_PROMPT: string;
export declare function installVision(ctx: Context, settings: () => VisionSettings): void;
