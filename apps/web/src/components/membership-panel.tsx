"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getAccountMembership } from "@/lib/cloud";
import {
  MEMBERSHIP_FEATURE_LABELS,
  MEMBERSHIP_FEATURES,
  MEMBERSHIP_SOURCE_LABELS,
  type AccountMembership,
} from "@/lib/membership";
import "./membership-panel.css";

type State =
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "ready"; membership: AccountMembership };

function localDateTime(timestamp: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

const ENFORCEMENT_NOTES = {
  off: "会员额度尚未启用：当前所有账号按全站统一的每日次数计算，下表为会员启用后的额度。",
  shadow: "会员额度试运行中：暂时仍按全站统一的每日次数计算，下表为会员启用后的额度。",
  on: null,
} as const;

function AccountMembershipView({ userId }: { userId: string }) {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const request = new AbortController();
    getAccountMembership(userId, request.signal).then(
      (membership) => {
        if (active) setState({ kind: "ready", membership });
      },
      (error: unknown) => {
        if (!active || request.signal.aborted) return;
        setState({
          kind: "error",
          message:
            error instanceof Error && error.name === "CloudError"
              ? error.message
              : "暂时无法读取会员信息，请检查网络后刷新。",
        });
      },
    );
    return () => {
      active = false;
      request.abort();
    };
  }, [userId, attempt]);

  const membership = state.kind === "ready" ? state.membership : undefined;
  const planName = (code: string | null) =>
    membership?.plans.find((plan) => plan.code === code)?.name ?? code;
  const note = membership ? ENFORCEMENT_NOTES[membership.enforcement] : null;

  return (
    <section className="membership-panel" aria-label="会员等级">
      <header className="membership-heading">
        <div>
          <h3>会员等级</h3>
          <p>会员按账号生效，Web 与其他设备共用。</p>
        </div>
        <button
          type="button"
          className="btn membership-refresh"
          disabled={state.kind === "checking"}
          onClick={() => {
            setState({ kind: "checking" });
            setAttempt((value) => value + 1);
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {state.kind === "checking" ? "正在读取" : "刷新"}
        </button>
      </header>
      <div aria-live="polite" className="membership-content">
        {state.kind === "checking" ? (
          <p role="status">正在读取当前账号的会员信息…</p>
        ) : state.kind === "error" ? (
          <div className="membership-unknown" role="status">
            <strong>会员信息暂不可用</strong>
            <p>{state.message}</p>
          </div>
        ) : membership ? (
          <>
            <div className="membership-current">
              <span className="membership-badge" data-plan={membership.planCode}>
                {membership.planName}
              </span>
              <div className="membership-validity">
                <p>
                  {membership.source
                    ? MEMBERSHIP_SOURCE_LABELS[membership.source]
                    : "未开通会员，默认免费版"}
                </p>
                {membership.source && (
                  <p>
                    {membership.endsAt ? (
                      <>
                        有效期至{" "}
                        <time dateTime={membership.endsAt}>{localDateTime(membership.endsAt)}</time>
                        （本机时间），到期后为{planName(membership.afterEnd ?? "free")}
                      </>
                    ) : (
                      "长期有效"
                    )}
                  </p>
                )}
              </div>
            </div>
            {note && <p className="membership-note">{note}</p>}
            <dl className="membership-limits">
              <div>
                <dt>每日 AI 请求</dt>
                <dd>
                  {membership.limits.aiDailyRequests}
                  <small> 次</small>
                </dd>
              </div>
              <div>
                <dt>活跃学习空间</dt>
                <dd>
                  {membership.limits.learningSpaces}
                  <small> 个</small>
                </dd>
              </div>
            </dl>
            <ul className="membership-features" aria-label="AI 功能">
              {MEMBERSHIP_FEATURES.map((key) => (
                <li key={key} data-available={membership.features[key]}>
                  <span>{MEMBERSHIP_FEATURE_LABELS[key]}</span>
                  <b>{membership.features[key] ? "可用" : "未开放"}</b>
                </li>
              ))}
            </ul>
            {membership.plans.length > 1 && (
              <div className="membership-plans">
                <table>
                  <caption>会员方案</caption>
                  <thead>
                    <tr>
                      <th scope="col">等级</th>
                      <th scope="col">每日 AI 请求</th>
                      <th scope="col">活跃学习空间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {membership.plans.map((plan) => (
                      <tr
                        key={plan.code}
                        aria-current={plan.code === membership.planCode ? "true" : undefined}
                      >
                        <th scope="row">
                          {plan.name}
                          {plan.code === membership.planCode && <small>（当前）</small>}
                        </th>
                        <td>{plan.limits.aiDailyRequests} 次</td>
                        <td>{plan.limits.learningSpaces} 个</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="btn" disabled>
                  升级（暂未开放）
                </button>
                <p>在线开通尚未上线；阅读、搜索、笔记和导出不受会员等级影响。</p>
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** Account/context keys replace the subtree, so a late response never reaches another account. */
export default function MembershipPanel({
  userId,
  contextKey,
  enabled = true,
}: {
  userId?: string;
  contextKey: string;
  enabled?: boolean;
}) {
  if (!userId || !enabled)
    return (
      <section className="membership-panel" aria-label="会员等级">
        <h3>会员等级</h3>
        <p>
          {userId ? "正在确认当前工作区，请稍后查看会员信息。" : "登录后可查看当前账号的会员等级。"}
        </p>
      </section>
    );
  return <AccountMembershipView key={JSON.stringify([userId, contextKey])} userId={userId} />;
}
