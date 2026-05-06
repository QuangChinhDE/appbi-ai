'use client';

import React from 'react';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';

interface Props {
  isOpen: boolean;
  workboardName: string;
  username: string;
  pin: string;
  /** Confirmed: user clicked the "I saved this" button. */
  onConfirm: () => void;
}

type CopyKey = 'username' | 'pin' | 'both';

export function DefaultOwnerCredentialsDialog({
  isOpen,
  workboardName,
  username,
  pin,
  onConfirm,
}: Props) {
  const [confirmed, setConfirmed] = React.useState(false);
  const [copied, setCopied] = React.useState<CopyKey | null>(null);

  React.useEffect(() => {
    if (isOpen) {
      setConfirmed(false);
      setCopied(null);
    }
  }, [isOpen]);

  const copy = async (key: CopyKey, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      toast.error('Không thể copy. Hãy chọn và copy thủ công.');
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      // Click backdrop / X is treated as "I will lose this" — bounce a warning
      // toast and force the user back to the confirm checkbox. We never
      // silently drop the credentials.
      onClose={() => {
        if (confirmed) {
          onConfirm();
          return;
        }
        toast.error(
          'Hãy lưu lại username + PIN trước khi đóng — đây là tài khoản admin đầu tiên cho mini-app.',
        );
      }}
      title="Tài khoản admin mặc định cho mini-app"
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copy('both', `${username} / ${pin}`)}
            leadingIcon={
              copied === 'both' ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )
            }
          >
            {copied === 'both' ? 'Đã copy' : 'Copy cả hai'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!confirmed}
            onClick={onConfirm}
            title={
              confirmed
                ? 'Vào builder để cấu hình mini-app'
                : 'Tick xác nhận đã lưu PIN ở trên trước'
            }
          >
            Tôi đã lưu — vào Builder
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/5 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="text-tiny text-text-secondary">
            <p className="font-emphasis text-text-primary">
              PIN này chỉ hiện đúng 1 lần.
            </p>
            <p className="mt-0.5">
              Hãy copy và gửi cho người sẽ quản trị mini-app{' '}
              <span className="font-emphasis text-text-primary">“{workboardName}”</span>.
              Sau khi đóng cửa sổ này, hệ thống không hiển thị lại được nữa —
              nếu mất, bạn phải vào tab <span className="font-emphasis">Users</span>{' '}
              để đặt lại PIN.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <CredentialField
            label="Tên đăng nhập"
            value={username}
            onCopy={() => copy('username', username)}
            copied={copied === 'username'}
            icon={<KeyRound className="h-3.5 w-3.5" />}
          />
          <CredentialField
            label="PIN"
            value={pin}
            onCopy={() => copy('pin', pin)}
            copied={copied === 'pin'}
            mono
          />
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2.5 text-tiny text-text-secondary hover:border-brand">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
          <span>
            Tôi đã copy/lưu lại tên đăng nhập và PIN ở nơi an toàn (mật khẩu
            quản lý, ghi chú nội bộ, v.v.)
          </span>
        </label>
      </div>
    </Modal>
  );
}

function CredentialField({
  label,
  value,
  onCopy,
  copied,
  mono,
  icon,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-emphasis text-text-tertiary">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <code
          className={`flex-1 select-all rounded bg-surface-1 px-2 py-1.5 text-body text-text-primary ${
            mono ? 'font-mono tracking-wider' : ''
          }`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="flex shrink-0 items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1.5 text-tiny font-medium text-text-secondary hover:border-brand hover:text-brand"
          title={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Đã copy
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
