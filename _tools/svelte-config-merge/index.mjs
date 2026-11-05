import { deepmergeCustom } from "deepmerge-ts";

/**
 * The configuration merge contract used by @sveltejs/vite-plugin-svelte.
 * @param {unknown} target
 * @param {unknown} source
 * @param {{arrayMerge?: (target: ReadonlyArray<unknown>, source: ReadonlyArray<unknown>) => ReadonlyArray<unknown>}} options
 */
export default function mergeConfig(target, source, options = {}) {
    if (Object.keys(options).some((key) => key !== "arrayMerge")) {
        throw new TypeError("Unsupported Svelte configuration merge option");
    }
    const arrayMerge = options.arrayMerge;
    if (typeof arrayMerge !== "function") {
        throw new TypeError("Svelte configuration requires an array merge function");
    }
    const merge = deepmergeCustom({
        filterValues: false,
        mergeArrays: (values) => values.reduce((left, right) => arrayMerge(left, right)),
    });
    return merge(target, source);
}
