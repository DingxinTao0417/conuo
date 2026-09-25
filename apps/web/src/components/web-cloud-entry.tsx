"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { Cloud, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isCloudConfigured, subscribeSession, type CloudUser } from "@/lib/cloud";
import type { AuthMode, Lang } from "./landing/auth-copy";
import WebCloudAuthDialog from "./web-cloud-auth-dialog";
import Workspace from "./workspace";
import "./web-cloud-entry.css";

type EntryState =
  { kind: "loading" | "login" | "unavailable" } | { kind: "ready"; user: CloudUser };
type AuthRequest = { mode: AuthMode; lang: Lang; id: number };

// The homepage (three.js, GSAP, Lenis) is only fetched for signed-out visitors.
const Landing = dynamic(() => import("./landing/landing"), {
  ssr: false,
  loading: () => <main className="web-cloud-entry" aria-busy="true" />,
});

/** A workspace hash (#library, #source/…) means the visitor was heading into the app. */
function wantsWorkspace() {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  return hash.length > 1 && !hash.startsWith("#lp-");
}

/** Web only opens an account workspace after authoritative Supabase verification. */
export default function WebCloudEntry() {
  const [entry, setEntry] = useState<EntryState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [auth, setAuth] = useState<AuthRequest | null>(null);
  const verifiedUser = useRef<CloudUser | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    // Deep links skip the homepage pitch and go straight to the account dialog.
    const promptForDeepLink = () => {
      if (wantsWorkspace()) setAuth((current) => current ?? { mode: "login", lang: "zh", id: 0 });
    };
    const unavailable = () => {
      if (!active) return;
      verifiedUser.current = null;
      setEntry({ kind: "unavailable" });
      promptForDeepLink();
    };
    try {
      if (!isCloudConfigured()) queueMicrotask(unavailable);
      else
        unsubscribe = subscribeSession(
          (user) => {
            if (!active) return;
            verifiedUser.current = user;
            setEntry(user ? { kind: "ready", user } : { kind: "login" });
            if (user) setAuth(null);
            else promptForDeepLink();
          },
          (hintedId) => {
            if (!active || !verifiedUser.current || verifiedUser.current.id === hintedId) return;
            // Cached events can revoke A immediately, but cannot authorize B.
            verifiedUser.current = null;
            setEntry({ kind: "loading" });
          },
        );
    } catch {
      queueMicrotask(unavailable);
    }
    return () => {
      active = false;
      verifiedUser.current = null;
      unsubscribe();
    };
  }, [attempt]);

  const openAuth = useCallback(
    (mode: AuthMode, lang: Lang) =>
      setAuth((current) => ({ mode, lang, id: (current?.id ?? 0) + 1 })),
    [],
  );
  const closeAuth = useCallback(() => setAuth(null), []);

  if (entry.kind === "ready") return <Workspace key={entry.user.id} storageMode="cloud" />;

  if (entry.kind === "loading")
    return (
      <main className="web-cloud-entry">
        <div className="web-cloud-entry-shell">
          <div className="web-cloud-brand" aria-label="Conuo">
            <Image src="/conuo-icon-192.png" alt="" width={40} height={40} priority />
            <span>Conuo</span>
          </div>
          <section className="web-cloud-entry-card" aria-labelledby="web-cloud-entry-title">
            <div className="web-cloud-entry-intro">
              <span className="web-cloud-entry-label">
                <Cloud size={15} />
                云端学习工作区
              </span>
              <h1 id="web-cloud-entry-title">正在连接你的工作区</h1>
              <p>资料、笔记与学习记录统一保存至云端，登录后即可继续。</p>
            </div>
            <p className="web-cloud-entry-status" role="status">
              <LoaderCircle size={19} className="web-cloud-entry-spinner" />
              正在确认登录状态…
            </p>
          </section>
          <p className="web-cloud-entry-footer">陪你把知识学会。</p>
        </div>
      </main>
    );

  return (
    <>
      <Landing onAuth={openAuth} paused={auth !== null} />
      {auth ? (
        <WebCloudAuthDialog
          key={auth.id}
          request={auth.mode}
          lang={auth.lang}
          unavailable={entry.kind === "unavailable"}
          onClose={closeAuth}
          onRetry={() => {
            setEntry({ kind: "loading" });
            setAttempt((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}
