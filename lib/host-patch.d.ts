import type { Context } from '@deepseek-ai/cordis';
export interface HostPatchConfig {
    /** Re-apply the host image-admission patch at plugin load when missing (default true). */
    autoApply: boolean;
}
/**
 * Ensure the host image-admission patch is present on the first candidate file
 * that exists. Idempotent: already-patched files are left alone. Failures are
 * logged, never thrown — a patch failure must not take the plugin down.
 */
export declare function autoApplyHostPatch(ctx: Context, config: HostPatchConfig): Promise<void>;
