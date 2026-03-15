import { ChatPanel } from '@/components/ai-chat/ChatPanel';

interface Props {
  params: { sessionId: string };
}

export default function ChatSessionPage({ params }: Props) {
  return (
    <div className="h-[calc(100vh-0px)] flex flex-col">
      <ChatPanel sessionId={params.sessionId} />
    </div>
  );
}
