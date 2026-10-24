import { PersistentMap } from "octagonal-wheels/dataobject/PersistentMap";
import { compareMTime } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { EVEN } from "@vrtmrz/livesync-commonlib/compat/common/models/shared.const.symbols";

function isRedundant(path: string, times: number[]): boolean {
    // Internal-file callers also use exact membership; preserve their records.
    if (path.includes(":") || path.startsWith(".")) return false;
    return (
        Array.isArray(times) &&
        times.length > 0 &&
        times.every((time) => Number.isFinite(time) && compareMTime(time, times[0]) === EVEN)
    );
}

/** Keeps only timestamp equivalences which the ordinary file comparison cannot already establish. */
export class SameChangePairs extends PersistentMap<number[]> {
    constructor(key: string) {
        super(key);
        let changed = false;
        for (const [path, times] of this._map) {
            if (isRedundant(path, times)) {
                this._map.delete(path);
                changed = true;
            }
        }
        // Shrinking the existing key also makes room for the host's Vault selector.
        if (changed) this.flush();
    }

    override set(path: string, times: number[]): this {
        if (!isRedundant(path, times)) return super.set(path, times);
        if (this.has(path)) this.delete(path);
        return this;
    }
}
