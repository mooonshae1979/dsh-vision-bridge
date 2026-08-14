const FREE_HINTS = ['flash', 'free', 'lite', 'mini', 'light', '免费', 'fast'];
function guessFree(name) {
    const hay = name.toLowerCase();
    return FREE_HINTS.some((hint) => hay.includes(hint));
}
/** Models whose provider adapter declares image input, as discovery candidates. */
export async function discoverVisionModels(ctx) {
    const llm = ctx.get('llm');
    if (llm === undefined)
        return [];
    let providers;
    try {
        providers = llm.listProviders();
    }
    catch {
        return [];
    }
    const out = [];
    for (const provider of providers) {
        let models;
        try {
            models = await llm.listModels(provider.id);
        }
        catch {
            continue; // one broken catalog must not kill discovery
        }
        for (const model of models) {
            if (model.inputModalities !== undefined && model.inputModalities.includes('image')) {
                const label = model.name ?? model.id;
                out.push({
                    provider: provider.id,
                    model: model.id,
                    name: label,
                    free: guessFree(label),
                    quality: 3,
                });
            }
        }
    }
    return out;
}
/**
 * Resolve the full ordered list of vision routes a read-image subagent may use,
 * best first. `mode: 'manual'` yields at most the one explicit route; `auto`
 * yields every usable discovered/candidate route sorted free-first, then by
 * quality. Returns an empty list only when nothing usable is available (the
 * caller then degrades to a transcription-failure placeholder). Callers may
 * walk the list for retry-after-failure instead of giving up on the best route.
 */
export async function selectVisionModelCandidates(ctx, config) {
    if (config.mode === 'manual') {
        return config.manual.provider.length > 0
            ? [{ provider: config.manual.provider, ...(config.manual.model?.length ? { model: config.manual.model } : {}) }]
            : [];
    }
    // Auto: configured candidates + discovery, deduped (candidate metadata wins).
    const llm = ctx.get('llm');
    if (llm === undefined)
        return [];
    let registered;
    try {
        registered = new Set(llm.listProviders().map((p) => p.id));
    }
    catch {
        registered = new Set();
    }
    const byKey = new Map();
    const freeProviders = new Set(config.freeProviders);
    for (const c of config.candidates) {
        byKey.set(`${c.provider}/${c.model}`, {
            provider: c.provider,
            model: c.model,
            free: c.free ?? freeProviders.has(c.provider) ?? guessFree(c.model),
            quality: c.quality ?? 3,
        });
    }
    for (const found of await discoverVisionModels(ctx)) {
        const label = `${found.provider}/${found.model}`;
        if (byKey.has(label))
            continue;
        byKey.set(label, {
            ...found,
            free: freeProviders.has(found.provider) || found.free,
        });
    }
    const usable = [...byKey.values()].filter((c) => registered.has(c.provider));
    usable.sort((a, b) => Number(b.free) - Number(a.free) ||
        b.quality - a.quality ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model));
    return usable.map((c) => ({ provider: c.provider, model: c.model }));
}
/**
 * Resolve the best vision route for one read-image subagent.
 * Returns `undefined` only when nothing usable is available (the caller then
 * degrades to a transcription-failure placeholder).
 */
export async function selectVisionModel(ctx, config) {
    return (await selectVisionModelCandidates(ctx, config))[0];
}
