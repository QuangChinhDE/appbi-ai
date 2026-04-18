export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-surface-0">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,rgb(94_106_210/0.08),transparent)]" />
      <div className="relative">{children}</div>
    </div>
  );
}
