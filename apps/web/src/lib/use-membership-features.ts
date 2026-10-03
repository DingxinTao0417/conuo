"use client";

import { useEffect, useMemo, useState } from "react";
import * as cloud from "./cloud";
import type { AccountMembership, MembershipFeatureKey } from "./membership";

/** A stale membership is kept while a refresh runs or fails, so entries never flicker. */
type MembershipEntry = { membership?: AccountMembership; error?: unknown; fetchedAt: number };

/** Admin grants appear without a reload; a failed read is retried sooner. */
const FRESH_MS = 60_000;
const ERROR_RETRY_MS = 15_000;

const cache = new Map<string, MembershipEntry>();
const requests = new Map<string, Promise<AccountMembership>>();
const listeners = new Map<string, Set<() => void>>();

/**
 * The public switches are build-time values. Organization and region study did
 * not historically have a browser switch, so an omitted value keeps the old
 * visible behavior; an explicit off still disables the entry point.
 */
function deploymentEnabled(feature: MembershipFeatureKey) {
  switch (feature) {
    case "vision_region":
      return process.env.NEXT_PUBLIC_CONUO_FEATURE_VISION_REGION !== "off";
    case "organization":
      return process.env.NEXT_PUBLIC_CONUO_FEATURE_ORGANIZATION !== "off";
    case "learning_ai":
      return process.env.NEXT_PUBLIC_CONUO_FEATURE_LEARNING === "on";
    case "deep_thinking":
      return process.env.NEXT_PUBLIC_CONUO_FEATURE_DEEP_THINKING === "on";
    case "tutor_mode":
      return process.env.NEXT_PUBLIC_CONUO_FEATURE_TUTOR_MODE === "on";
  }
}

export function membershipDeploymentFeatureEnabled(feature: MembershipFeatureKey) {
  return deploymentEnabled(feature);
}

function notify(userId: string) {
  listeners.get(userId)?.forEach((listener) => listener());
}

function ensureRequest(userId: string) {
  if (requests.has(userId)) return;
  const current = cache.get(userId);
  if (current && Date.now() - current.fetchedAt < (current.error ? ERROR_RETRY_MS : FRESH_MS))
    return;
  let membershipReader: ((expectedUserId: string) => Promise<AccountMembership>) | undefined;
  try {
    membershipReader = cloud.getAccountMembership;
  } catch {
    membershipReader = undefined;
  }
  if (typeof membershipReader !== "function") {
    cache.set(userId, {
      membership: current?.membership,
      error: new Error("会员接口不可用"),
      fetchedAt: Date.now(),
    });
    notify(userId);
    return;
  }
  const promise = membershipReader(userId)
    .then((membership) => {
      cache.set(userId, { membership, fetchedAt: Date.now() });
      return membership;
    })
    .catch((error: unknown) => {
      cache.set(userId, {
        membership: cache.get(userId)?.membership,
        error,
        fetchedAt: Date.now(),
      });
      throw error;
    })
    .finally(() => {
      requests.delete(userId);
      notify(userId);
    });
  requests.set(userId, promise);
  // Consumers read the shared cache; avoid an unhandled rejection when the
  // membership endpoint is unavailable in an offline or staging workspace.
  void promise.catch(() => undefined);
}

function subscribe(userId: string | undefined, listener: () => void) {
  if (!userId) return () => {};
  const current = listeners.get(userId) ?? new Set<() => void>();
  current.add(listener);
  listeners.set(userId, current);
  return () => {
    current.delete(listener);
    if (!current.size) listeners.delete(userId);
  };
}

function read(userId: string | undefined): MembershipEntry | null {
  if (!userId) return null;
  return cache.get(userId) ?? null;
}

/** Fetches one account membership per account and shares it across AI panels. */
export function useMembershipFeature(
  userId: string | undefined,
  feature: MembershipFeatureKey,
): {
  ready: boolean;
  allowed: boolean;
  reason?: string;
  membership?: AccountMembership;
} {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!userId || !deploymentEnabled(feature)) return;
    const unsubscribe = subscribe(userId, () => rerender((value) => value + 1));
    ensureRequest(userId);
    // Returning to the page re-reads a stale or failed membership.
    const refresh = () => {
      if (document.visibilityState !== "hidden") ensureRequest(userId);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [feature, userId]);

  const entry = read(userId);

  return useMemo(() => {
    const deployment = deploymentEnabled(feature);
    // Local/offline workspaces have no cloud identity and must retain their
    // existing controls. Cloud users are gated by the resolved membership.
    if (!userId) return { ready: true, allowed: deployment };
    if (!deployment)
      return {
        ready: true,
        allowed: false,
        reason: "此功能尚未在当前版本开放。",
      };
    if (entry?.membership)
      return entry.membership.features[feature]
        ? { ready: true, allowed: true, membership: entry.membership }
        : {
            ready: true,
            allowed: false,
            membership: entry.membership,
            reason: "当前会员等级未开放此功能。",
          };
    // The membership read failed and nothing is cached. The server checks the
    // plan again on every AI request, so keep the entry usable instead of
    // disabling every AI feature during a membership outage.
    if (entry?.error) return { ready: true, allowed: true };
    return {
      ready: false,
      allowed: false,
      reason: "正在读取会员权限，请稍候。",
    };
  }, [entry, feature, userId]);
}

export function resetMembershipFeatureCache(userId?: string) {
  if (userId) {
    cache.delete(userId);
    return;
  }
  cache.clear();
}
