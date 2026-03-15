import { ChatPanel } from '@/components/ai-chat/ChatPanel';

export const metadata = {
  title: 'AI Chat — AppBI',
};

export default function ChatPage() {
  return (
    // Full height inside the (main) layout: main element has ml-64 and overflow-y-auto
    // We want the chat to fill that space without double scrollbars
    <div className="h-[calc(100vh-0px)] flex flex-col">
      <ChatPanel />
    </div>
  );
}
