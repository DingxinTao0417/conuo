import Link from "next/link";
export default function AuthErrorPage() {
  return (
    <main style={{ maxWidth: 460, margin: "15vh auto", padding: 24, display: "grid", gap: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.45 }}>这个登录链接暂时无法使用</h1>
      <p style={{ lineHeight: 1.8, color: "var(--text-secondary)" }}>
        链接可能已过期、已被使用，或不是在发起操作的浏览器中打开。请返回工作区重新发送确认或重置邮件。
      </p>
      <Link
        href="/"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifySelf: "start",
          minHeight: 44,
          padding: "0 14px",
          borderRadius: 8,
          background: "var(--brand-soft)",
          color: "var(--brand)",
          fontWeight: 500,
        }}
      >
        返回 Conuo
      </Link>
    </main>
  );
}
