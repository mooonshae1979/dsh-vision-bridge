import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MessageId, } from '@deepseek-ai/dsh-llm';
import { selectVisionModelCandidates } from './models.js';
export const DEFAULT_TRANSCRIBE_PROMPT = '你是全能视觉眼睛(transcription engine),任务是把图片内容精确转成文字,供另一个大模型继续工作。请严格遵守:\n' +
    '1. 逐字转写所有文字:报错信息、日志、代码、UI 文案、文件名、行号,不翻译、不纠错、不改写;\n' +
    '2. 代码用 ``` 围栏包裹;\n' +
    '3. 若图片是报错截图,提取错误类型、错误消息、堆栈关键行、出错文件与行号;\n' +
    '4. 描述界面布局与关键视觉元素(弹窗、按钮、高亮、红框、颜色),以及它们在图中的大致位置;\n' +
    '5. 多张图按出现顺序分别标注【图1】【图2】...。\n' +
    '只转写与提取信息,不要解决问题、不要给建议、不要推断原因。' +
    '\n直接输出转写结果本身,不要输出任何多余的解释、开场白或结尾语。';
function isImage(block) {
    return block.type === 'image';
}
/**
 * Collect user-message images grouped by message, keeping each message's text
 * attached — the vision model must see the user's question ("这是谁？", "这个
 * 报错怎么办？") alongside the image, or it merely transcribes pixels without
 * serving the user's intent. Plugin-injected images (e.g. generate_image
 * output, `source.kind !== 'user'`) are excluded exactly as before.
 */
function collectImageEntries(messages) {
    const entries = [];
    for (const message of messages) {
        if (message.source?.kind !== 'user')
            continue;
        const images = message.content.filter(isImage);
        if (images.length === 0)
            continue;
        const text = message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
            .trim();
        entries.push({ images, text });
    }
    return entries;
}
/** Build the vision-model prompt: images + fixed transcribe instruction + the user's intent. */
function buildTranscriptionPrompt(entries, settings) {
    const blocks = [];
    entries.forEach((entry, index) => {
        for (const image of entry.images)
            blocks.push({ ...image });
        if (settings.includeUserText && entry.text.length > 0) {
            blocks.push({
                type: 'text',
                text: `【第${index + 1}组图片的用户附言/需求】\n${entry.text}\n` +
                    '—— 用户对图片有自己的提问或指令，请在转写时理解并优先回应（如识别图中人物身份、提取报错、核对内容等），再继续逐字转写。',
            });
        }
    });
    blocks.push({ type: 'text', text: settings.transcribePrompt });
    return blocks;
}
/** Strip the branded `sha256:` prefix, if any, to get the bare object id. */
function bareAttachmentId(attachmentId) {
    return attachmentId.startsWith('sha256:') ? attachmentId.slice('sha256:'.length) : attachmentId;
}
/**
 * Best-effort local path of the attachment object, so a failing transcription
 * still tells the main agent where the original image lives (it can then read
 * the file directly instead of hunting for the wrong picture). Returns
 * `undefined` when the local attachment store layout is not present.
 */
function attachmentObjectPath(attachmentId) {
    try {
        const id = bareAttachmentId(attachmentId);
        if (id.length < 2)
            return undefined;
        const root = join(homedir(), '.dsh', 'attachments', 'v1', 'objects');
        const candidate = join(root, id.slice(0, 2), id);
        return existsSync(candidate) ? candidate : undefined;
    }
    catch {
        return undefined;
    }
}
/** Human-readable one-line source info for one image attachment. */
function describeImage(ref) {
    const parts = [];
    if (ref.name !== undefined && ref.name.length > 0)
        parts.push(ref.name);
    parts.push(`${ref.width}x${ref.height}`);
    if (ref.bytes >= 1024)
        parts.push(`${Math.round(ref.bytes / 102.4) / 10}KB`);
    parts.push(ref.mediaType);
    return parts.join(', ');
}
/** Failure placeholder that tells the main agent what happened and where the original image is. */
function failurePlaceholder(reason, routes, images, settings) {
    const lines = [`【图片转写失败: ${reason}】`];
    if (routes.length > 0) {
        lines.push(`已尝试视觉路由: ${routes
            .map((r) => (r.model !== undefined && r.model.length > 0 ? `${r.provider}/${r.model}` : r.provider))
            .join(' → ')}`);
    }
    if (settings.includeAttachmentInfo) {
        for (const image of images) {
            const info = describeImage(image.attachment);
            lines.push(`图片来源: ${info}`);
            const path = attachmentObjectPath(image.attachment.attachmentId);
            lines.push(path !== undefined
                ? `原图文件: ${path}（可用视觉 workflow 直接重读此文件）`
                : `附件ID: ${image.attachment.attachmentId}（本地附件库未找到对应文件）`);
        }
    }
    return lines.join('\n');
}
/** Replace every image block with the transcription text (first) or a short pointer. */
function replaceImages(blocks, text) {
    let first = true;
    const out = [];
    for (const block of blocks) {
        if (isImage(block)) {
            if (first) {
                out.push({
                    type: 'text',
                    text: `【图片内容转写】\n${text}`,
                });
                first = false;
            }
            else {
                out.push({ type: 'text', text: '(见上方图片内容转写)' });
            }
            continue;
        }
        out.push(block);
    }
    return out;
}
/** Whether the agent's current model declares image input (native vision). */
async function modelSeesImages(ctx, agent, cache) {
    const { provider, model } = agent.options;
    if (provider === undefined || model === undefined)
        return false;
    const key = `${provider}/${model}`;
    const hit = cache.get(key);
    if (hit !== undefined)
        return hit;
    const llm = ctx.get('llm');
    if (llm === undefined)
        return false;
    try {
        const info = await llm.resolveModelInfo(provider, model);
        const sees = info.inputModalities?.includes('image') === true;
        cache.set(key, sees);
        return sees;
    }
    catch {
        // Unresolvable route: leave the step alone and let the normal error path
        // report the problem, rather than rewriting under a broken assumption.
        return false;
    }
}
/** Direct transcription through the selected vision route (fallback when subagents are unavailable). */
async function transcribeDirect(ctx, entries, settings, signal, route) {
    const llm = ctx.get('llm');
    const content = [
        ...buildTranscriptionPrompt(entries, settings),
    ];
    const messages = [
        {
            id: MessageId(`dsh-vision-bridge:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`),
            role: 'user',
            content,
            source: { kind: 'user' },
        },
    ];
    const parts = [];
    try {
        for await (const chunk of llm.stream({
            provider: route.provider,
            model: route.model ?? '',
            messages,
            signal,
        })) {
            if (chunk.type === 'text-delta') {
                parts.push(chunk.text);
            }
            else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                return `【图片转写失败: ${chunk.reason.failure.message}】`;
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `【图片转写失败: ${message}】`;
    }
    const text = parts.join('');
    return text.length > 0 ? text : '【图片转写失败: 视觉模型未返回内容】';
}
/**
 * Transcribe through one-shot read-image subagents. The child is a real DSH
 * agent whose `agentOptions` pin the selected vision provider/model (the same
 * `ctx.subagents` machinery AgentTeams members are built on), with every tool
 * filtered away so it only looks at the images and returns the transcription.
 *
 * Retry semantics: `routes` is the ordered candidate list (best first). We try
 * up to `maxAttempts` distinct routes; a route that fails (spawn error,
 * non-completed stop reason, empty output) is skipped for the next one, so a
 * transient model outage no longer produces a dead end. When every subagent
 * attempt fails and `fallbackToDirect` is set, one final attempt runs through
 * a direct `llm.stream` on the best route.
 *
 * Cancellation composition: the per-attempt AbortController is the child's
 * signal and stays alive until that attempt's `run.result` settles — it is
 * deliberately NOT aborted right after `start()` returns (a `subagents.start`
 * resolves once the child is published, long before it finishes; aborting the
 * controller there would cancel the child before it ever runs, surfacing as a
 * meaningless `stopReason: 'aborted'`). The timer and the parent-signal
 * listener are removed on every path.
 */
async function transcribeViaSubagent(ctx, parent, entries, settings, signal, routes) {
    const images = entries.flatMap((entry) => entry.images);
    const subagents = ctx.get('subagents');
    if (subagents === undefined || routes.length === 0) {
        if (routes.length === 0) {
            return failurePlaceholder('未发现可用的视觉路由', routes, images, settings);
        }
        return transcribeDirect(ctx, entries, settings, signal, routes[0]);
    }
    const prompt = buildTranscriptionPrompt(entries, settings);
    const failures = [];
    const attempts = Math.max(1, settings.maxAttempts);
    for (let i = 0; i < Math.min(attempts, routes.length); i++) {
        const route = routes[i];
        if (signal.aborted) {
            return failurePlaceholder('请求已被中止（父级取消，未继续重试）', routes.slice(0, i + 1), images, settings);
        }
        const agentOptions = {
            provider: route.provider,
            ...(route.model !== undefined && route.model.length > 0 ? { model: route.model } : {}),
        };
        // Manual cancellation composition (AbortSignal.any needs Node 20.3+):
        // caller signal + our timeout. Both stay live until the attempt settles.
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason ?? 'parent aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort('transcribe timeout'), settings.transcribeTimeoutMs);
        let run;
        try {
            run = await subagents.start('spawn', {
                label: 'dsh-vision-bridge:read-image',
                prompt,
                parent,
                signal: controller.signal,
                agentOptions,
                toolFilter: { allow: [] },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`spawn 失败: ${message}`);
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            continue;
        }
        const parts = [];
        try {
            const result = await run.result;
            if (result.stopReason !== 'completed') {
                const abortNote = controller.signal.aborted
                    ? `（${String(controller.signal.reason ?? '已中止')}）`
                    : '';
                failures.push(`视觉子 agent 未完成 (${result.stopReason})${abortNote}`);
                continue;
            }
            for (const block of result.output) {
                if (block.type === 'text' && block.text.length > 0)
                    parts.push(block.text);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(message);
            continue;
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            try {
                await run.dispose();
            }
            catch {
                // Disposal failure must not mask a successful transcription.
            }
        }
        const text = parts.join('').trim();
        if (text.length > 0)
            return text;
        failures.push('视觉子 agent 未返回内容');
    }
    // Every subagent attempt failed: one direct llm.stream retry on the best route.
    if (settings.fallbackToDirect && !signal.aborted) {
        const direct = await transcribeDirect(ctx, entries, settings, signal, routes[0]);
        if (!direct.startsWith('【图片转写失败'))
            return direct;
        failures.push(`直连转写也失败: ${direct.replace('【图片转写失败: ', '').replace(/】$/, '')}`);
    }
    const reason = failures.length > 0 ? failures.join('; ') : '未获取到转写结果';
    return failurePlaceholder(reason, routes, images, settings);
}
export function installVision(ctx, settings) {
    const nativeVisionCache = new Map();
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision === undefined || decision.kind !== 'enter')
            return decision;
        const current = settings();
        // Native vision routes see images themselves; leave their steps untouched.
        // This also covers the read-image subagent — the recursion guard.
        if (await modelSeesImages(ctx, payload.agent, nativeVisionCache))
            return decision;
        // Only transcribe images from the user's own messages. Plugin-injected
        // images (e.g. generate_image output) pass through untouched so the
        // conversation shows the picture instead of a transcription of it. Each
        // message's own text travels with its images, so the vision model knows
        // what the user is asking about.
        const entries = collectImageEntries(decision.messages);
        const images = entries.flatMap((entry) => entry.images);
        if (images.length === 0)
            return decision;
        const route = await selectVisionModelCandidates(ctx, current.modelSelection);
        const text = route.length === 0
            ? '【图片转写失败: 未发现可用的视觉模型;请为某个 llm provider 配置声明 image 模态的模型(如 opencode-go 的 mimo-v2.5)】'
            : await transcribeViaSubagent(ctx, payload.agent, entries, current, payload.signal, route);
        const rewritten = decision.messages.map((message) => message.content.some(isImage)
            ? { ...message, content: replaceImages(message.content, text) }
            : message);
        return { kind: 'enter', messages: rewritten };
    });
}
