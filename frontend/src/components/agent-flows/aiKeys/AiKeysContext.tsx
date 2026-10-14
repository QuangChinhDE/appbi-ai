'use client';

/**
 * AI Keys — one list of the author's usable keys, shared by the manager modal and
 * every step's model picker in the Agent Flow module.
 *
 * ONE PROVIDER FOR THE MODULE, NOT ONE FETCH PER STEP. A flow has many model steps;
 * each asking the server for the same list is waste, and — worse — a key added in
 * the modal would not appear in a picker that fetched before it existed. Adding a
 * key here refreshes every picker at once.
 *
 * The secret never passes through this file: the server returns `key_hint` only.
 */
import React from 'react';

import { listCredentials, type AiCredential, type Provider } from '@/lib/agentFlows';

import { AiKeysModal } from './AiKeysModal';

interface OpenOptions {
  /** Start on the add form for this provider. */
  provider?: Provider;
  /** Called with a key created from this opening — how a picker fills itself in. */
  onCreated?: (credential: AiCredential) => void;
}

interface AiKeysValue {
  credentials: AiCredential[];
  loaded: boolean;
  canEdit: boolean;
  reload: () => Promise<AiCredential[]>;
  open: (options?: OpenOptions) => void;
}

const NOOP: AiKeysValue = {
  credentials: [],
  loaded: true,
  canEdit: false,
  reload: async () => [],
  open: () => undefined,
};

const AiKeysContext = React.createContext<AiKeysValue>(NOOP);

export function AiKeysProvider({ canEdit, children }: { canEdit: boolean; children: React.ReactNode }) {
  const [credentials, setCredentials] = React.useState<AiCredential[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [opened, setOpened] = React.useState<OpenOptions | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const rows = await listCredentials();
      setCredentials(rows);
      return rows;
    } catch {
      // A failed list must not break the builder; the picker then says "no key".
      setCredentials([]);
      return [];
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => { void reload(); }, [reload]);

  const value = React.useMemo<AiKeysValue>(() => ({
    credentials,
    loaded,
    canEdit,
    reload,
    open: (options) => setOpened(options || {}),
  }), [credentials, loaded, canEdit, reload]);

  return (
    <AiKeysContext.Provider value={value}>
      {children}
      {opened && (
        <AiKeysModal
          credentials={credentials}
          loaded={loaded}
          canEdit={canEdit}
          initialProvider={opened.provider}
          onChanged={reload}
          onCreated={(c) => { opened.onCreated?.(c); }}
          onClose={() => setOpened(null)}
        />
      )}
    </AiKeysContext.Provider>
  );
}

export function useAiKeys(): AiKeysValue {
  return React.useContext(AiKeysContext);
}
