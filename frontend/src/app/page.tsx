/**
 * `/` — send the user straight into the default landing module.
 *
 * A server redirect rather than a client `router.push`: the browser no longer
 * downloads a page bundle just to bounce, so there is no spinner frame on every
 * cold entry and no window in which a landing module could mount twice. The
 * target follows `DEFAULT_LANDING_PATH`, so switching the Home module back on
 * moves this redirect with it.
 */
import { redirect } from 'next/navigation';

import { DEFAULT_LANDING_PATH } from '@/lib/feature-flags';

export default function RootPage() {
  redirect(DEFAULT_LANDING_PATH);
}
