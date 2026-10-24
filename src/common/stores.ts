import { SameChangePairs } from "./sameChangePairs";

export let sameChangePairs: SameChangePairs;

export function initializeStores(vaultName: string) {
    sameChangePairs = new SameChangePairs(`ls-persist-same-changes-${vaultName}`);
}
