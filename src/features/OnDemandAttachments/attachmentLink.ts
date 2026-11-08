function normalise(path: string): string | null {
    const result: string[] = [];
    for (const part of path.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (!result.length) return null;
            result.pop();
        } else {
            if (part.startsWith(".") || /[\\:\0\r\n]/u.test(part)) return null;
            result.push(part);
        }
    }
    return result.join("/");
}

/** Resolve exact or unique attachment links; an ambiguous basename never selects arbitrary content. */
export class DeferredAttachmentLinks {
    private readonly paths: Set<string>;
    private readonly names = new Map<string, Set<string>>();

    constructor(paths: readonly string[]) {
        this.paths = new Set(paths);
        for (const path of paths) {
            this.add(path);
        }
    }

    add(path: string): void {
        this.paths.add(path);
        const name = path.slice(path.lastIndexOf("/") + 1);
        const matches = this.names.get(name) ?? new Set<string>();
        matches.add(path);
        this.names.set(name, matches);
    }

    remove(path: string): void {
        this.paths.delete(path);
        this.names.get(path.slice(path.lastIndexOf("/") + 1))?.delete(path);
    }

    resolve(target: string, sourcePath: string, exactResource = false, resolvedPath?: string): string | null {
        if (resolvedPath && !this.paths.has(resolvedPath)) return null;
        if (!target || target.startsWith("/") || /^[a-z][a-z\d+.-]*:/iu.test(target)) return null;
        let decoded: string;
        try {
            decoded = decodeURIComponent(target.split("|")[0].split("#")[0].split("?")[0]);
        } catch {
            return null;
        }
        const direct = normalise(decoded);
        if (exactResource) return direct && this.paths.has(direct) ? direct : null;
        const parent = sourcePath.slice(0, Math.max(0, sourcePath.lastIndexOf("/")));
        const relative = normalise(`${parent}/${decoded}`);
        if (direct && relative && direct !== relative && this.paths.has(direct) && this.paths.has(relative))
            return null;
        if (direct && this.paths.has(direct)) return direct;
        if (relative && this.paths.has(relative)) return relative;
        if (decoded.includes("/")) return null;
        const matches = this.names.get(decoded);
        return matches?.size === 1 ? [...matches][0] : null;
    }
}
