/**
 * `generate_image` — text-to-image via Volcengine Ark (Doubao Seedream).
 *
 * POST /api/v3/images/generations (synchronous), downloads the result bytes
 * into the durable attachment store, and injects the image into the session
 * so the user sees it in the conversation (and the main model can reference
 * it on the next turn).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createUserMessage,
  LlmError,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'

export interface ImageGenSettings {
  /** Volcengine Ark base URL, e.g. https://ark.cn-beijing.volces.com/api/v3 */
  baseURL: string
  /** Credentials env var name holding the Ark API key. */
  apiKeyEnv: string
  /** Seedream model id, e.g. doubao-seedream-5-0-260128. */
  model: string
  /** Ordered Seedream model list; the first entry is the default. Empty falls back to `model`. */
  models: Array<{ id: string; name?: string }>
  /** Default output size: '2k' | '3k' | '4k' (Seedream presets). */
  defaultSize: string
  /** Show the "AI生成" watermark (default false). */
  watermark: boolean
}

const SIZES = new Set(['2k', '3k', '4k'])

/**
 * Resolve which Seedream model to use for one request.
 * Priority: an explicit `model` argument (matched against the configured
 * `models` list by id or short name, else used verbatim) → the first entry of
 * the configured `models` list → the configured `model` fallback.
 */
function resolveModel(
  requested: string | undefined,
  settings: ImageGenSettings,
): { id: string; label: string } {
  const list = settings.models.length > 0 ? settings.models : [{ id: settings.model }]
  if (requested !== undefined && requested.trim().length > 0) {
    const want = requested.trim()
    const hit = list.find((m) => m.id === want || m.name === want)
    if (hit !== undefined) return { id: hit.id, label: hit.name ?? hit.id }
    // Unknown explicit request: use it verbatim (the backend will validate).
    return { id: want, label: want }
  }
  const first = list[0]
  return { id: first.id, label: first.name ?? first.id }
}

function validateSize(size: string): string {
  const s = size.trim().toLowerCase()
  if (SIZES.has(s)) return s
  // Also accept WIDTHxHEIGHT with >= 1920*1920 pixels (Seedream min).
  const m = /^(\d{3,5})x(\d{3,5})$/i.exec(size.trim())
  if (m !== null) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (w >= 1920 && h >= 1920 && w * h >= 3_686_400) return `${w}x${h}`
  }
  throw new Error(`size must be one of '2k', '3k', '4k', or WIDTHxHEIGHT with >=1920px per side; got "${size}"`)
}

async function arkJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal })
  } catch (error) {
    if (signal.aborted) throw new LlmError('image generation aborted by caller', 'ABORTED', { cause: error })
    throw new Error(`Ark request failed: ${String(error)}`)
  }
  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    // keep empty body
  }
  if (!response.ok) {
    const err = (body.error ?? {}) as { code?: string; message?: string }
    const code = (err.code ?? `HTTP_${response.status}`) as string
    const message = (err.message ?? `Ark HTTP ${response.status}`) as string
    if (code === 'Throttling' || response.status === 429) {
      throw new LlmError(`Ark throttled: ${message}`, 'RATE_LIMIT', { status: response.status })
    }
    if (code === 'InvalidApiKey' || code === 'invalid_api_key' || response.status === 401) {
      throw new LlmError(`Ark invalid API key: ${message}`, 'AUTH', { status: response.status })
    }
    throw new Error(`Ark error ${code}: ${message}`)
  }
  return { status: response.status, body }
}

function mediaTypeFor(url: string, contentType: string | null): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (contentType !== null) {
    if (contentType.includes('png')) return 'image/png'
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'image/jpeg'
    if (contentType.includes('webp')) return 'image/webp'
  }
  const lower = url.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

async function downloadImage(url: string, signal: AbortSignal): Promise<{ data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`failed to download generated image (HTTP ${response.status})`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength === 0) throw new Error('downloaded generated image is empty')
  return { data, mediaType: mediaTypeFor(url, response.headers.get('content-type')) }
}

export function registerImageGenTool(
  ctx: Context,
  settings: () => ImageGenSettings,
  resolveKey: (ref: string) => Promise<string>,
): void {
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt using the Volcengine Doubao Seedream text-to-image model. ' +
      'Returns the generated image(s) into the conversation. The prompt should be a detailed visual description.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Detailed visual description of the image to generate (subject, scene, style, lighting).',
      },
      size: {
        type: 'string',
        description: 'Output size: "2k" (default), "3k", "4k", or WIDTHxHEIGHT with >=1920px per side.',
      },
      n: {
        type: 'number',
        description: 'Number of images to generate (1..4, default 1; billed per image).',
      },
      model: {
        type: 'string',
        description:
          'Optional Seedream model to use: "5.0" (default), "4.5", "4.0", or a full model id. ' +
          'Omit to use the configured default (the model with the most remaining quota).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          model: { type: 'string', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: {
                  type: 'string',
                  enum: ['image/png', 'image/jpeg', 'image/webp'],
                  required: true,
                },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
          failures: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const blocks: ContentBlock[] = [
          {
            type: 'text',
            text:
              value.images.length > 0
                ? `已生成 ${value.images.length} 张图片(模型 ${value.model})。\n图片描述: ${value.prompt}`
                : `图片生成失败: 未返回任何图片(模型 ${value.model})`,
          },
          ...value.images.map((image: ImageGenImageValue): ContentBlock => {
            const ref: ImageAttachmentRef = {
              attachmentId: image.attachmentId as ImageAttachmentRef['attachmentId'],
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              ...(image.name !== undefined ? { name: image.name } : {}),
            }
            return { type: 'image', attachment: ref }
          }),
        ]
        return blocks
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.prompt.trim().length === 0) throw new Error('prompt must be a non-empty string')
      const current = settings()
      const size = args.size === undefined ? current.defaultSize : validateSize(args.size)
      const n = Math.min(4, Math.max(1, Math.floor(args.n ?? 1)))
      const { id: modelId, label: modelLabel } = resolveModel(args.model, current)
      const apiKey = await resolveKey(current.apiKeyEnv)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('generate_image: no attachment service is mounted')

      const urls: string[] = []
      const b64s: string[] = []
      const { body } = await arkJson(
        `${current.baseURL.replace(/\/+$/, '')}/images/generations`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: modelId,
            prompt: args.prompt,
            size,
            n,
            response_format: 'url',
            watermark: current.watermark,
          }),
        },
        exec.signal,
      )
      const data = (body.data ?? []) as Array<{ url?: string; b64_json?: string }>
      for (const item of data) {
        if (item.url !== undefined) urls.push(item.url)
        else if (item.b64_json !== undefined) b64s.push(item.b64_json)
      }
      if (urls.length === 0 && b64s.length === 0) {
        throw new Error('image backend returned no results')
      }

      const images: ImageGenImageValue[] = []
      const failures: string[] = []
      const taskId = String(Math.random()).slice(2, 10)
      for (const item of urls) {
        try {
          const { data: bytes, mediaType } = await downloadImage(item, exec.signal)
          if (bytes.byteLength > attachments.imageLimits.maxImageBytes) {
            failures.push(`image exceeds deployment byte limit (${bytes.byteLength} > ${attachments.imageLimits.maxImageBytes})`)
            continue
          }
          const ref = await attachments.saveImage({ data: bytes, mediaType, name: `gen-${taskId}` })
          images.push({
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType as 'image/png' | 'image/jpeg' | 'image/webp',
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name !== undefined ? { name: ref.name } : {}),
          })
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      for (const b64 of b64s) {
        try {
          const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
          if (bytes.byteLength > attachments.imageLimits.maxImageBytes) {
            failures.push(`image exceeds deployment byte limit (${bytes.byteLength} > ${attachments.imageLimits.maxImageBytes})`)
            continue
          }
          const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'gen-b64' })
          images.push({
            attachmentId: String(ref.attachmentId),
            mediaType: 'image/png',
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name !== undefined ? { name: ref.name } : {}),
          })
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }

      const value = {
        prompt: args.prompt,
        model: modelLabel,
        images,
        ...(failures.length > 0 ? { failures } : {}),
      }

      // Make the generated image visible in the conversation (user side).
      if (images.length > 0) {
        const message = createUserMessage({
          content: [
            { type: 'text', text: `【生图完成】${images.length} 张图片已生成: ${args.prompt}` },
            ...images.map((image) => {
              const ref: ImageAttachmentRef = {
                attachmentId: image.attachmentId as ImageAttachmentRef['attachmentId'],
                mediaType: image.mediaType,
                bytes: image.bytes,
                width: image.width,
                height: image.height,
              }
              return { type: 'image', attachment: ref } satisfies ContentBlock
            }),
          ],
          source: { kind: 'plugin', plugin: 'dsh-vision-bridge' },
        })
        try {
          exec.agent?.inject(message)
        } catch (error) {
          // Agent may be disposed; the tool value still carries the references.
          ctx.logger.warn(`generate_image: inject failed: ${String(error)}`)
        }
      }

      return value
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '生成图片',
        kind: 'other',
        content: [
          { type: 'text', text: args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}…` : args.prompt },
        ],
      }
    },
  }))
}

interface ImageGenImageValue {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: number
  width: number
  height: number
  name?: string
}

export type { ImageGenImageValue }
