/**
 * Keeps a synchronised write from reaching the plug-in's own folder, or its trusted-keys file, through a symbolic
 * link or junction.
 *
 * The {@link PathAliasGuard} checks that every segment of a path is listed by its parent under that name, but a
 * symbolic link or junction IS listed under its own name, so a path such as `updates/main.js`, where `updates` is a
 * link into `.obsidian/plugins/obsidian-livesync`, passes every segment check while the file system resolves it
 * into the protected folder. The rules which decide by the spelling of a path never see the real destination.
 *
 * On desktop the real path is resolved natively, and a write, append, removal, directory creation or rename target
 * which a link resolves into a protected path is refused. The common case, where no segment of the path is a link,
 * resolves the path's existing prefix and compares it with the cached protected targets. Existing targets are also
 * compared by file identity with the protected installed files, so a listed hard-link alias is refused. Where
 * resolution or identity is unavailable for an existing target, the change is refused rather than let through blind.
 *
 * On the mobile adapter no guard is wired: its file system cannot represent or follow symbolic links or junctions,
 * so a vault path can never resolve anywhere but where it is spelled, and the vector cannot arise there.
 */

/** The native file-system operations the guard needs. Injected so the guard itself pulls in no platform module. */
export interface LinkResolvingFileSystem {
    /** Whether a path exists on disk. It should resolve false rather than reject when it cannot tell. */
    exists(absolutePath: string): Promise<boolean>;
    /** The canonical real path, resolving every symbolic link and junction. Rejects when it cannot be resolved. */
    realpath(absolutePath: string): Promise<string>;
    /** Stable identity of an existing file or directory, equal for hard links to the same object. */
    identity(absolutePath: string): Promise<string | undefined>;
}

/** The path operations the guard needs, the platform's own, so comparison matches how the file system resolves. */
export interface PathOperations {
    resolve(...segments: string[]): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
}

export interface ProtectedPathLinkGuard {
    /** Refuse a change which a symbolic link or junction resolves into a protected path or removal ancestor. */
    assertNoLinkEscape(vaultRelativePath: string, operation?: "change" | "remove"): Promise<void>;
}

const REFUSAL = "Refusing a path which a symbolic link or junction resolves into the protected plug-in folder.";

/** Fold a real path for comparison the way the supported file systems do: Unicode NFC and case. */
const fold = (path: string) => path.normalize("NFC").toLowerCase();

/** A guard which does nothing, for a file system without links (mobile) or where no protection is configured. */
export function noProtectedPathLinkGuard(): ProtectedPathLinkGuard {
    return { assertNoLinkEscape: async () => {} };
}

export function createProtectedPathLinkGuard(options: {
    /** The vault root on disk, already canonical. Protected and written paths are resolved against it. */
    vaultBasePath: string;
    /** The vault-relative files and folders which no write may reach, such as the plug-in folder and its keys file. */
    protectedPaths: string[];
    fs: LinkResolvingFileSystem;
    path: PathOperations;
}): ProtectedPathLinkGuard {
    const { vaultBasePath, protectedPaths, fs, path } = options;

    /** The protected paths in their real, resolved form; computed once and reused. */
    let protectedReal: string[] | undefined;
    const protectedIdentities = new Map<string, string>();
    const resolveProtected = async (): Promise<string[]> => {
        if (protectedReal) return protectedReal;
        const resolved: string[] = [];
        for (const protectedPath of protectedPaths) {
            const absolute = path.resolve(vaultBasePath, protectedPath);
            try {
                resolved.push(await fs.realpath(absolute));
            } catch {
                // Not created yet: its lexical location is where it will be, and a link into it is caught all the same.
                resolved.push(absolute);
            }
        }
        protectedReal = resolved;
        return protectedReal;
    };

    const isWithin = (parent: string, child: string): boolean => {
        if (fold(parent) === fold(child)) return true;
        const relative = path.relative(parent, child);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    };

    const protectedIdentity = async (target: string): Promise<string | undefined> => {
        const cached = protectedIdentities.get(target);
        if (cached) return cached;
        const identity = await fs.identity(target);
        if (identity) protectedIdentities.set(target, identity);
        return identity;
    };

    return {
        async assertNoLinkEscape(vaultRelativePath: string, operation = "change"): Promise<void> {
            const segments = vaultRelativePath.split("/").filter((segment) => segment !== "");
            if (segments.length === 0) return;
            // The deepest existing prefix of the path: the whole path when it exists, else its longest existing
            // ancestor. A link is only ever traversed through a segment which already exists.
            let existingAbsolute: string | undefined;
            let existingLength = 0;
            for (let length = segments.length; length >= 1; length--) {
                const absolute = path.resolve(vaultBasePath, ...segments.slice(0, length));
                if (await fs.exists(absolute)) {
                    existingAbsolute = absolute;
                    existingLength = length;
                    break;
                }
            }
            // Nothing on the path exists yet, so no segment can be a link: the entry is about to be created afresh.
            if (existingAbsolute === undefined) return;
            let real: string;
            try {
                real = await fs.realpath(existingAbsolute);
            } catch {
                // An existing prefix which cannot be resolved may be a link we cannot follow: refuse, do not guess.
                throw new Error(REFUSAL);
            }
            // Where the change would really land, including any uncreated suffix after the resolved prefix.
            const realTarget = path.resolve(real, ...segments.slice(existingLength));
            let existingIdentity: string | undefined;
            if (existingLength === segments.length) {
                try {
                    existingIdentity = await fs.identity(existingAbsolute);
                } catch {
                    throw new Error(REFUSAL);
                }
                if (!existingIdentity) throw new Error(REFUSAL);
            }
            for (const target of await resolveProtected()) {
                if (isWithin(target, realTarget) || (operation === "remove" && isWithin(realTarget, target))) {
                    throw new Error(REFUSAL);
                }
                if (existingIdentity && existingIdentity === (await protectedIdentity(target))) {
                    throw new Error("Refusing a hard link to protected plug-in storage.");
                }
            }
        },
    };
}
