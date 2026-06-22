import PwaRegister from '@/components/pwa/PwaRegister';
import OfflineBar from '@/components/offline/OfflineBar';

/** Wraps the public workspace runtime ( /ws/[token] and its workboards ) and
 *  registers the PWA service worker so the mini-app is installable + offline,
 *  plus the offline submit-queue status bar (auto-syncs on reconnect). */
export default function WorkspaceRuntimeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <PwaRegister />
      <OfflineBar />
    </>
  );
}
