import { defineTool } from '@deepseek-ai/dsh-tools';
import { LlmError } from '@deepseek-ai/dsh-llm';
const SIZES = new Set(['2k', '3k', '4k']);
/**
 * Resolve which Seedream model to use for one request.
 * Priority: an explicit `model` argument (matched against the configured
 * `models` list by id or short name, else used verbatim) → the first entry of
 * the configured `models` list → the configured `model` fallback.
 */
function resolveModel(requested, settings) {
    const list = settings.models.length > 0 ? settings.models : [{ id: settings.model }];
    if (requested !== undefined && requested.trim().length > 0) {
        const want = requested.trim();
        const hit = list.find((m) => m.id === want || m.name === want);
        if (hit !== undefined)
            return { id: hit.id, label: hit.name ?? hit.id };
        // Unknown explicit request: use it verbatim (the backend will validate).
        return { id: want, label: want };
    }
    const first = list[0];
    return { id: first.id, label: first.name ?? first.id };
}
function validateSize(size) {
    const s = size.trim().toLowerCase();
    if (SIZES.has(s))
        return s;
    // Also accept WIDTHxHEIGHT with >= 1920*1920 pixels (Seedream min).
    const m = /^(\d{3,5})x(\d{3,5})$/i.exec(size.trim());
    if (m !== null) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (w >= 1920 && h >= 1920 && w * h >= 3_686_400)
            return `${w}x${h}`;
    }
    throw new Error(`size must be one of '2k', '3k', '4k', or WIDTHxHEIGHT with >=1920px per side; got "${size}"`);
}
async function arkJson(url, init, signal) {
    let response;
    try {
        response = await fetch(url, { ...init, signal });
    }
    catch (error) {
        if (signal.aborted)
            throw new LlmError('image generation aborted by caller', 'ABORTED', { cause: error });
        throw new Error(`Ark request failed: ${String(error)}`);
    }
    let body = {};
    try {
        body = (await response.json());
    }
    catch {
        // keep empty body
    }
    if (!response.ok) {
        const err = (body.error ?? {});
        const code = (err.code ?? `HTTP_${response.status}`);
        const message = (err.message ?? `Ark HTTP ${response.status}`);
        if (code === 'Throttling' || response.status === 429) {
            throw new LlmError(`Ark throttled: ${message}`, 'RATE_LIMIT', { status: response.status });
        }
        if (code === 'InvalidApiKey' || code === 'invalid_api_key' || response.status === 401) {
            throw new LlmError(`Ark invalid API key: ${message}`, 'AUTH', { status: response.status });
        }
        throw new Error(`Ark error ${code}: ${message}`);
    }
    return { status: response.status, body };
}
function mediaTypeFor(url, contentType) {
    if (contentType !== null) {
        if (contentType.includes('png'))
            return 'image/png';
        if (contentType.includes('jpeg') || contentType.includes('jpg'))
            return 'image/jpeg';
        if (contentType.includes('webp'))
            return 'image/webp';
    }
    const lower = url.toLowerCase();
    if (lower.endsWith('.png'))
        return 'image/png';
    if (lower.endsWith('.webp'))
        return 'image/webp';
    return 'image/jpeg';
}
/** File extension for a stored image media type (used when copying to cwd). */
function mediaTypeToExt(mediaType) {
    if (mediaType.includes('png'))
        return '.png';
    if (mediaType.includes('webp'))
        return '.webp';
    return '.jpg';
}
async function downloadImage(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok)
        throw new Error(`failed to download generated image (HTTP ${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0)
        throw new Error('downloaded generated image is empty');
    return { data, mediaType: mediaTypeFor(url, response.headers.get('content-type')) };
}
export function registerImageGenTool(ctx, settings, resolveKey) {
    ctx.tools.register(defineTool({
        name: 'generate_image',
        description: 'Generate an image from a text prompt using the Volcengine Doubao Seedream text-to-image model. ' +
            'The image is saved to the durable attachment store and copied into the session working directory ' +
            '(when one is known) so the user can open the file; the result text carries the attachment references. ' +
            'The prompt should be a detailed visual description.',
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
                description: 'Optional Seedream model to use: "5.0" (default), "4.5", "4.0", or a full model id. ' +
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
                // NOTE: deliberately text-only. The main model may be a text-only route
                // (e.g. DeepSeek-V4-Flash-Official) that cannot accept image blocks in
                // its request; returning image blocks here would put them into the
                // model-facing tool result and fail the step. The image bytes are saved
                // to the durable attachment store (and copied to the session cwd when
                // possible) so the user can still view them; the text carries the
                // attachment references for any later tool to re-read.
                const lines = [];
                if (value.images.length > 0) {
                    lines.push(`已生成 ${value.images.length} 张图片(模型 ${value.model})。`);
                    lines.push(`图片描述: ${value.prompt}`);
                    value.images.forEach((image, index) => {
                        const size = image.width > 0 && image.height > 0 ? `${image.width}x${image.height}` : '';
                        const bytes = image.bytes >= 1024 ? `${Math.round(image.bytes / 102.4) / 10}KB` : `${image.bytes}B`;
                        lines.push(`图${index + 1}: attachmentId=${image.attachmentId}${size ? `, ${size}` : ''}, ${bytes}, ${image.mediaType}` +
                            (image.name !== undefined && image.name.length > 0 ? `, name=${image.name}` : ''));
                    });
                }
                else {
                    lines.push(`图片生成失败: 未返回任何图片(模型 ${value.model})`);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            if (args.prompt.trim().length === 0)
                throw new Error('prompt must be a non-empty string');
            const current = settings();
            const size = args.size === undefined ? current.defaultSize : validateSize(args.size);
            const n = Math.min(4, Math.max(1, Math.floor(args.n ?? 1)));
            const { id: modelId, label: modelLabel } = resolveModel(args.model, current);
            const apiKey = await resolveKey(current.apiKeyEnv);
            const attachments = ctx.get('attachments');
            if (attachments === undefined)
                throw new Error('generate_image: no attachment service is mounted');
            const urls = [];
            const b64s = [];
            const { body } = await arkJson(`${current.baseURL.replace(/\/+$/, '')}/images/generations`, {
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
            }, exec.signal);
            const data = (body.data ?? []);
            for (const item of data) {
                if (item.url !== undefined)
                    urls.push(item.url);
                else if (item.b64_json !== undefined)
                    b64s.push(item.b64_json);
            }
            if (urls.length === 0 && b64s.length === 0) {
                throw new Error('image backend returned no results');
            }
            const images = [];
            const failures = [];
            const taskId = String(Math.random()).slice(2, 10);
            for (const item of urls) {
                try {
                    const { data: bytes, mediaType } = await downloadImage(item, exec.signal);
                    if (bytes.byteLength > attachments.imageLimits.maxImageBytes) {
                        failures.push(`image exceeds deployment byte limit (${bytes.byteLength} > ${attachments.imageLimits.maxImageBytes})`);
                        continue;
                    }
                    const ref = await attachments.saveImage({ data: bytes, mediaType, name: `gen-${taskId}` });
                    images.push({
                        attachmentId: String(ref.attachmentId),
                        mediaType: ref.mediaType,
                        bytes: ref.bytes,
                        width: ref.width,
                        height: ref.height,
                        ...(ref.name !== undefined ? { name: ref.name } : {}),
                    });
                }
                catch (error) {
                    failures.push(error instanceof Error ? error.message : String(error));
                }
            }
            for (const b64 of b64s) {
                try {
                    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
                    if (bytes.byteLength > attachments.imageLimits.maxImageBytes) {
                        failures.push(`image exceeds deployment byte limit (${bytes.byteLength} > ${attachments.imageLimits.maxImageBytes})`);
                        continue;
                    }
                    const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'gen-b64' });
                    images.push({
                        attachmentId: String(ref.attachmentId),
                        mediaType: 'image/png',
                        bytes: ref.bytes,
                        width: ref.width,
                        height: ref.height,
                        ...(ref.name !== undefined ? { name: ref.name } : {}),
                    });
                }
                catch (error) {
                    failures.push(error instanceof Error ? error.message : String(error));
                }
            }
            const value = {
                prompt: args.prompt,
                model: modelLabel,
                images,
                ...(failures.length > 0 ? { failures } : {}),
            };
            // Make the generated image visible to the user WITHOUT putting image
            // blocks into the model-facing context. Injecting an image message would
            // queue it for the next pre-step, and on a text-only route (e.g.
            // DeepSeek-V4-Flash-Official) the image block would reach the model and
            // fail the step. Instead we copy the bytes into the session working
            // directory (when one is known) so the user can open the file directly;
            // the tool-result text already carries the attachment references.
            if (images.length > 0 && exec.agent !== undefined) {
                const cwd = exec.agent.session?.header?.cwd;
                if (cwd !== undefined && cwd.length > 0) {
                    const fs = await import('node:fs');
                    const path = await import('node:path');
                    const ext = mediaTypeToExt(images[0].mediaType);
                    for (let i = 0; i < images.length; i++) {
                        const image = images[i];
                        try {
                            const ref = {
                                attachmentId: image.attachmentId,
                                mediaType: image.mediaType,
                                bytes: image.bytes,
                                width: image.width,
                                height: image.height,
                            };
                            const stored = await attachments.readImage(ref, exec.signal);
                            const fileName = `generated_image_${taskId}_${i + 1}${ext}`;
                            const target = path.join(cwd, fileName);
                            fs.writeFileSync(target, stored.data);
                            ctx.logger.info(`generate_image: saved ${target} (${stored.data.byteLength} bytes)`);
                        }
                        catch (error) {
                            // Copying to cwd is best-effort; the attachment store is the
                            // durable home and the tool result still references it.
                            ctx.logger.warn(`generate_image: failed to copy image ${i + 1} to cwd: ${String(error)}`);
                        }
                    }
                }
            }
            return value;
        },
        presentCall(args) {
            return {
                card: 'generic',
                title: '生成图片',
                kind: 'other',
                content: [
                    { type: 'text', text: args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}…` : args.prompt },
                ],
            };
        },
    }));
}
