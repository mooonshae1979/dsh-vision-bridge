/**
 * `generate_image` — text-to-image via Volcengine Ark (Doubao Seedream).
 *
 * POST /api/v3/images/generations (synchronous), downloads the result bytes
 * into the durable attachment store, and (when a session cwd is known) copies
 * the bytes into the working directory so the user can open the image. The
 * tool result is deliberately text-only: on a text-only main-model route
 * (e.g. DeepSeek-V4-Flash-Official) image blocks in the model-facing result
 * would fail the step, so the picture is never injected into model context.
 */
import type { Context } from '@deepseek-ai/cordis';
export interface ImageGenSettings {
    /** Volcengine Ark base URL, e.g. https://ark.cn-beijing.volces.com/api/v3 */
    baseURL: string;
    /** Credentials env var name holding the Ark API key. */
    apiKeyEnv: string;
    /** Seedream model id, e.g. doubao-seedream-5-0-260128. */
    model: string;
    /** Ordered Seedream model list; the first entry is the default. Empty falls back to `model`. */
    models: Array<{
        id: string;
        name?: string;
    }>;
    /** Default output size: '2k' | '3k' | '4k' (Seedream presets). */
    defaultSize: string;
    /** Show the "AI生成" watermark (default false). */
    watermark: boolean;
}
export declare function registerImageGenTool(ctx: Context, settings: () => ImageGenSettings, resolveKey: (ref: string) => Promise<string>): void;
interface ImageGenImageValue {
    attachmentId: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
    bytes: number;
    width: number;
    height: number;
    name?: string;
}
export type { ImageGenImageValue };
