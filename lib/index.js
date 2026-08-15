import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { autoApplyHostPatch } from './host-patch.js';
import { DEFAULT_TRANSCRIBE_PROMPT, installVision } from './vision.js';
import { registerImageGenTool } from './image-gen.js';
export const name = 'dsh-vision-bridge';
export const inject = ['llm', 'subagents', 'tools'];
export const NS = settingsNamespace('dsh-vision-bridge');
const modelSelectionSchema = z.object({
    mode: z.union([z.const('auto'), z.const('manual')]).default('auto'),
    freeProviders: z.array(z.string()).default([]),
    candidates: z
        .array(z.object({
        provider: z.string(),
        model: z.string(),
        free: z.boolean().required(false),
        quality: z.number().min(1).max(5).default(3),
    }))
        .default([]),
    manual: z
        .object({
        provider: z.string().default(''),
        model: z.string().default(''),
    })
        .default({ provider: '', model: '' }),
});
export const Config = z.object({
    hostPatch: z.object({
        autoApply: z.boolean().default(true),
    }),
    vision: z.object({
        transcribePrompt: z.string().default(DEFAULT_TRANSCRIBE_PROMPT),
        transcribeTimeoutMs: z.number().default(90_000),
        maxAttempts: z.number().min(1).default(2),
        fallbackToDirect: z.boolean().default(true),
        includeAttachmentInfo: z.boolean().default(true),
        includeUserText: z.boolean().default(true),
        modelSelection: modelSelectionSchema.default({
            mode: 'auto',
            freeProviders: [],
            candidates: [],
            manual: { provider: '', model: '' },
        }),
    }),
    image: z.object({
        enabled: z.boolean().default(true),
        baseURL: z.string().default('https://ark.cn-beijing.volces.com/api/v3'),
        apiKeyEnv: z.string().default('ARK_API_KEY'),
        model: z.string().default('doubao-seedream-5-0-260128'),
        models: z
            .array(z.object({
            id: z.string(),
            name: z.string().required(false),
        }))
            .default([]),
        defaultSize: z.string().default('2k'),
        watermark: z.boolean().default(false),
    }),
});
export function apply(ctx, config) {
    let current = () => config;
    const options = () => {
        try {
            return current();
        }
        catch (error) {
            ctx.logger.error('dsh-vision-bridge: keeping the last good configuration after an invalid settings section');
            ctx.logger.error(error);
            return config;
        }
    };
    // Host image-admission auto-patch (self-healing on every load).
    void autoApplyHostPatch(ctx, options().hostPatch).catch((error) => {
        ctx.logger.error('dsh-vision-bridge: host patch task failed');
        ctx.logger.error(error);
    });
    installSettingsSection(ctx, NS, Config, config, {
        setSource: (source) => {
            current = source;
        },
        onChange: () => {
            // Nothing to rebuild: model selection re-reads the live LLM directory
            // on every read-image step.
        },
    });
    // The eye: transcribe images on non-native routes via a read-image subagent.
    installVision(ctx, () => {
        const v = options().vision;
        return {
            modelSelection: v.modelSelection,
            transcribePrompt: v.transcribePrompt,
            transcribeTimeoutMs: v.transcribeTimeoutMs,
            maxAttempts: v.maxAttempts,
            fallbackToDirect: v.fallbackToDirect,
            includeAttachmentInfo: v.includeAttachmentInfo,
            includeUserText: v.includeUserText,
        };
    });
    // The hand: text-to-image via Volcengine Ark (Doubao Seedream).
    const resolveKey = async (ref) => {
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined && hit.value.length > 0)
                return hit.value;
        }
        else {
            const ambient = process.env[ref];
            if (ambient !== undefined && ambient.length > 0)
                return ambient;
        }
        throw new LlmError(`dsh-vision-bridge: no API key for image generation; store ${ref} through the credentials service, or export ${ref} in the launching environment`, 'MISSING_CREDENTIAL');
    };
    if (options().image.enabled) {
        registerImageGenTool(ctx, () => {
            const img = options().image;
            const s = {
                baseURL: img.baseURL,
                apiKeyEnv: img.apiKeyEnv,
                model: img.model,
                models: img.models,
                defaultSize: img.defaultSize,
                watermark: img.watermark,
            };
            return s;
        }, resolveKey);
    }
}
