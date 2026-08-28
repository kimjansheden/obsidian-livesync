import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export async function createDiagnosticsDirectory(scope: string, explicitDirectory?: string): Promise<string> {
    if (explicitDirectory) {
        const directory = resolve(explicitDirectory);
        await mkdir(directory, { recursive: true });
        return directory;
    }
    return await mkdtemp(join(tmpdir(), `obsidian-livesync-${scope}-`));
}
