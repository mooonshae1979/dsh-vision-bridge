/**
 * dsh-vision-bridge — let any text model accept images, read them via a
 * vision subagent.
 *
 * - **Host admission auto-patch**: every plugin load re-applies the minimal
 *   `RELAX_IMAGE_ADMISSION` patch to `dsh-host-apiproxy`, so text models stop
 *   refusing image attachments (and survive `npm update -g @deepseek-ai/dsh`).
 * - **The eye**: at `agent/pre-step`, any step whose model does not natively
 *   see (official DeepSeek, Trae, opencode-go text models, ...) gets its user
 *   images transcribed by a one-shot read-image subagent. The subagent's model
 *   is auto-discovered from the live LLM directory — every registered model
 *   that declares image input — ranked **free first, then by quality**.
 * - The plugin registers no provider: your model configuration stays the
 *   single source of truth (deepseek official, Trae, opencode-go, ...). A
 *   vision model is just a model whose route declares `input: [text, image]`.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type HostPatchConfig } from './host-patch.js';
import type { ModelSelectionConfig } from './models.js';
export declare const name = "dsh-vision-bridge";
export declare const inject: string[];
export declare const NS: import("@deepseek-ai/dsh-settings").SettingsNamespace;
export interface Config {
    hostPatch: HostPatchConfig;
    vision: {
        transcribePrompt: string;
        transcribeTimeoutMs: number;
        maxAttempts: number;
        fallbackToDirect: boolean;
        includeAttachmentInfo: boolean;
        includeUserText: boolean;
        modelSelection: ModelSelectionConfig;
    };
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
