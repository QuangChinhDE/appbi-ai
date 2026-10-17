/**
 * The commit this frontend bundle was BUILT from — inlined by `next build`
 * (`NEXT_PUBLIC_APPBI_BUILD_SHA`, set from the image's APPBI_BUILD_SHA build
 * arg). It is never "the HEAD of the source tree on disk": a container keeps
 * serving the bundle it was built with until it is rebuilt.
 *
 * Read back by scripts/ops/verify_frontend_runtime.py from three places that
 * must agree: the image label, `<meta name="appbi-build">` in the served HTML,
 * and the string itself inside a served JS chunk (what the browser executes).
 */
export const APPBI_BUILD_SHA: string = process.env.NEXT_PUBLIC_APPBI_BUILD_SHA || 'unknown';
