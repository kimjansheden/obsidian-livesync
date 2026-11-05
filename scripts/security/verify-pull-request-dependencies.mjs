import semver from "semver";

// Dependabot reports the default branch. A repair PR must instead prove that every reported range
// is absent from its complete lock graph; the release gate still checks the default branch itself.
export function evaluatePullRequestDependencies(lock, alerts) {
    const errors = [];
    if (lock?.lockfileVersion !== 3 || !lock.packages || !Object.hasOwn(lock.packages, "")) {
        return { ok: false, errors: ["A complete npm v3 lock graph is required."] };
    }
    if (!Array.isArray(alerts)) return { ok: false, errors: ["Dependabot response is malformed."] };
    for (const alert of alerts) {
        const dependency = alert?.dependency;
        const name = dependency?.package?.name;
        const rawRange = alert?.security_vulnerability?.vulnerable_version_range;
        const range = typeof rawRange === "string" ? semver.validRange(rawRange.replaceAll(",", " ")) : null;
        if (
            dependency?.package?.ecosystem !== "npm" ||
            dependency.manifest_path !== "package-lock.json" ||
            typeof name !== "string" ||
            !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name) ||
            !range
        ) {
            errors.push("An alert cannot be evaluated against the candidate npm lock graph.");
            continue;
        }
        for (const [path, entry] of Object.entries(lock.packages)) {
            let installed = entry;
            if (entry?.link) {
                const resolved = entry.resolved;
                const target = typeof resolved === "string" ? lock.packages[resolved] : undefined;
                if (
                    typeof resolved !== "string" ||
                    resolved.startsWith("/") ||
                    resolved.includes(":") ||
                    resolved.includes("\\") ||
                    resolved.split("/").some((part) => !part || part === "." || part === "..") ||
                    !target ||
                    target.link ||
                    typeof target.name !== "string" ||
                    !semver.valid(target.version)
                ) {
                    errors.push(`The candidate has an unverified workspace link at ${path}.`);
                    continue;
                }
                installed = target;
            }
            // Aliases and workspace links are identified by the installed package, not the import name.
            if (
                installed?.name
                    ? installed.name !== name
                    : path !== `node_modules/${name}` && !path.endsWith(`/node_modules/${name}`)
            )
                continue;
            if (
                !semver.valid(installed.version) ||
                semver.satisfies(installed.version, range, { includePrerelease: true })
            ) {
                errors.push(`The candidate still has an affected or unverified ${name} version at ${path}.`);
            }
        }
    }
    return { ok: errors.length === 0, errors };
}
