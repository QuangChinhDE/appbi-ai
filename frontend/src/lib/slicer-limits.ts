/** Slicer distinct-values prefetch size. Dependency-free on purpose: the PUBLIC
 *  dashboard bundle imports it, and must not pull in the authed API client. */
export const SLICER_DISTINCT_PREFETCH_LIMIT = 1000;
