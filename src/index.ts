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
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { autoApplyHostPatch, type HostPatchConfig } from './host-patch.js'
import { DEFAULT_TRANSCRIBE_PROMPT, installVision } from './vision.js'
import { registerImageGenTool, type ImageGenSettings } from './image-gen.js'
import type { ModelSelectionConfig } from './models.js'

export const name = 'dsh-vision-bridge'
export const inject = ['llm', 'subagents']

export const NS = settingsNamespace('dsh-vision-bridge')

export interface Config {
  hostPatch: HostPatchConfig
  vision: {
    transcribePrompt: string
    transcribeTimeoutMs: number
    maxAttempts: number
    fallbackToDirect: boolean
    includeAttachmentInfo: boolean
    includeUserText: boolean
    modelSelection: ModelSelectionConfig
  }
  image: {
    enabled: boolean
    baseURL: string
    apiKeyEnv: string
    model: string
    defaultSize: string
    watermark: boolean
  }
}

const modelSelectionSchema = z.object({
  mode: z.union([z.const('auto'), z.const('manual')]).default('auto'),
  freeProviders: z.array(z.string()).default([]),
  candidates: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string(),
        free: z.boolean().required(false),
        quality: z.number().min(1).max(5).default(3),
      }),
    )
    .default([]),
  manual: z
    .object({
      provider: z.string().default(''),
      model: z.string().default(''),
    })
    .default({ provider: '', model: '' }),
})

export const Config: z<Config> = z.object({
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
    defaultSize: z.string().default('2k'),
    watermark: z.boolean().default(false),
  }),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config): void {
  let current = () => config
  const options = (): Config => {
    try {
      return current()
    } catch (error) {
      ctx.logger.error('dsh-vision-bridge: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return config
    }
  }

  // Host image-admission auto-patch (self-healing on every load).
  void autoApplyHostPatch(ctx, options().hostPatch).catch((error) => {
    ctx.logger.error('dsh-vision-bridge: host patch task failed')
    ctx.logger.error(error)
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // Nothing to rebuild: model selection re-reads the live LLM directory
      // on every read-image step.
    },
  })

  // The eye: transcribe images on non-native routes via a read-image subagent.
  installVision(ctx, () => {
    const v = options().vision
    return {
      modelSelection: v.modelSelection,
      transcribePrompt: v.transcribePrompt,
      transcribeTimeoutMs: v.transcribeTimeoutMs,
      maxAttempts: v.maxAttempts,
      fallbackToDirect: v.fallbackToDirect,
      includeAttachmentInfo: v.includeAttachmentInfo,
      includeUserText: v.includeUserText,
    }
  })

  // The hand: text-to-image via Volcengine Ark (Doubao Seedream).
  const resolveKey = async (ref: string): Promise<string> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    } else {
      const ambient = process.env[ref]
      if (ambient !== undefined && ambient.length > 0) return ambient
    }
    throw new LlmError(
      `dsh-vision-bridge: no API key for image generation; store ${ref} through the credentials service, or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  if (options().image.enabled) {
    registerImageGenTool(ctx, () => {
      const img = options().image
      const s: ImageGenSettings = {
        baseURL: img.baseURL,
        apiKeyEnv: img.apiKeyEnv,
        model: img.model,
        defaultSize: img.defaultSize,
        watermark: img.watermark,
      }
      return s
    }, resolveKey)
  }
}
