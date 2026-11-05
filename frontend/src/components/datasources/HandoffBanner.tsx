'use client';

import { useSearchParams } from 'next/navigation';

/**
 * Shown when an assistant (an MCP integration) handed this step to the user:
 * credentials and sign-in are entered HERE, never through the assistant. After
 * saving, the user goes back to the assistant, which finds the source in AppBI.
 */
export function HandoffBanner() {
  const search = useSearchParams();
  if (search?.get('handoff') !== '1') return null;
  const type = (search.get('type') || '').slice(0, 40);
  const name = (search.get('name') || '').slice(0, 200);
  return (
    <div data-testid="source-handoff-banner" className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
      <div className="font-medium">Requested by your AI assistant</div>
      <div className="mt-0.5">
        {type || name ? <>Connect {type ? <b>{type}</b> : 'a source'}{name ? <> named <b>{name}</b></> : null}. </> : null}
        Enter the credentials or sign in here: they stay in AppBI and are never shared with the assistant.
        When it is saved, return to the assistant and say you are done.
      </div>
    </div>
  );
}
