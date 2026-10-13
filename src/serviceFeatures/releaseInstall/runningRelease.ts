/**
 * The build replaces this constant with its release marker: a fixed prefix followed by the release number of the
 * build. A release package is accepted only if the prefix occurs exactly once in its `main.js`, so this is the only
 * reference to the constant, and the prefix is not spelled anywhere else in the bundle.
 */
declare const SECURITY_RELEASE_MARKER: string;

const marker: string = SECURITY_RELEASE_MARKER;
const numberStart = marker.lastIndexOf(":") + 1;

/** The text which precedes the release number in the `main.js` of every build. */
export const RELEASE_MARKER_PREFIX = marker.slice(0, numberStart);

/** The release number which this build carries. */
export const RUNNING_RELEASE_NUMBER = Number(marker.slice(numberStart));
