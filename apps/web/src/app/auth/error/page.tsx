import Link from "next/link";
export default function AuthErrorPage() {
  return (
    <main style={{ maxWidth: 460, margin: "15vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 24 }}>这个登录链接暂时无法使用</h1>
      <p style={{ lineHeight: 1.8, color: "#737373" }}>
        链接可能已过期、已被使用，或不是在发起操作的浏览器中打开。请返回工作区重新发送确认或重置邮件。
      </p>
      <Link href="/" style={{ color: "#4B3FE3" }}>
        返回 Conuo
      </Link>
    </main>
  );
}
