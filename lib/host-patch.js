/**
 * Host image-admission patch — auto-heal on every plugin load.
 *
 * DSH's host (`@deepseek-ai/dsh-host-apiproxy` inside the installed bundle)
 * rejects a message carrying images when the selected model does not declare
 * image input. `dsh-vision-bridge` wants those messages admitted and routes
 * the images to a vision-capable subagent at `agent/pre-step` instead.
 *
 * `npm update -g @deepseek-ai/dsh` (or a reinstall) restores the stock host
 * file, silently undoing any manual patch. This module re-applies the same
 * minimal patch (a `RELAX_IMAGE_ADMISSION` switch, default true, in front of
 * the two admission checks) every time the plugin loads, so the patch is
 * self-healing: apply once, and it survives every future update. The
 * standalone `patch-host-apiproxy.ps1` script remains available for manual
 * apply / revert and shares the exact same anchors.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const MARKER = 'RELAX_IMAGE_ADMISSION';
const PATCH_CONST = `/**
 * dsh-multimodal patch: relax host image admission.
 * When true, a message carrying images is admitted even when the selected
 * model does not declare image input — the dsh-vision-bridge plugin's
 * agent/pre-step handler routes the images to a vision-capable subagent
 * instead of rejecting the message. Set to false to restore stock behavior.
 */
const RELAX_IMAGE_ADMISSION = true;`;
const ANCHOR_IMPORT = 'import { runNativeCommand } from "@deepseek-ai/dsh-native-command";';
const ANCHOR_PROMPT = 'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {';
const ANCHOR_SELECT = 'if (info.inputModalities !== void 0 && !info.inputModalities.includes("image")) return err(request, {';
/** Candidate locations of the host's `lib/index.js`, newest install layouts first. */
function candidatePaths() {
    const env = process.env;
    const appData = env.APPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Roaming');
    const roots = [
        join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy'),
        join(env.USERPROFILE ?? '', '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy'),
        join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy'),
    ];
    return roots.map((root) => join(root, 'lib', 'index.js'));
}
/** Apply the three textual edits; throws when an anchor is missing. */
function applyPatch(source) {
    if (!source.includes(ANCHOR_IMPORT))
        throw new Error('missing top import anchor');
    if (!source.includes(ANCHOR_PROMPT))
        throw new Error('missing prompt admission anchor');
    if (!source.includes(ANCHOR_SELECT))
        throw new Error('missing selectModel admission anchor');
    let out = source.replace(ANCHOR_IMPORT, `${ANCHOR_IMPORT}\n${PATCH_CONST}`);
    out = out.replace(ANCHOR_PROMPT, `if (RELAX_IMAGE_ADMISSION !== true && ${ANCHOR_PROMPT.slice(3)}`);
    out = out.replace(ANCHOR_SELECT, `if (RELAX_IMAGE_ADMISSION !== true && ${ANCHOR_SELECT.slice(3)}`);
    return out;
}
/**
 * Ensure the host image-admission patch is present on the first candidate file
 * that exists. Idempotent: already-patched files are left alone. Failures are
 * logged, never thrown — a patch failure must not take the plugin down.
 */
export async function autoApplyHostPatch(ctx, config) {
    if (!config.autoApply)
        return;
    for (const file of candidatePaths()) {
        if (!existsSync(file))
            continue;
        try {
            const content = await readFile(file, 'utf8');
            if (content.includes(MARKER)) {
                ctx.logger.info(`host image-admission patch already applied: ${file}`);
                return;
            }
            const backup = `${file}.bak-dsh-multimodal`;
            if (!existsSync(backup))
                await copyFile(file, backup);
            await writeFile(file, applyPatch(content), 'utf8');
            ctx.logger.info(`applied host image-admission patch: ${file} (backup: ${backup})`);
            ctx.logger.info('the patch is read at host boot; it takes effect on the next dsh start');
            return;
        }
        catch (error) {
            ctx.logger.error(`dsh-vision-bridge: host patch failed for ${file}`);
            ctx.logger.error(error);
            return;
        }
    }
    ctx.logger.warn('dsh-vision-bridge: dsh-host-apiproxy lib/index.js not found; host patch not applied. ' +
        'Text models may refuse image attachments (attachment-error). Run patch-host-apiproxy.ps1 manually.');
}
