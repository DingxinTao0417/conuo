"use client";

import { useEffect, useState } from "react";
import { getLearningSettings, saveLearningSettings, type LearningSettings } from "@/lib/cloud";
import type { WorkspaceUser } from "../../types";

export default function LearningPane({ user }: { user: NonNullable<WorkspaceUser> | null }) {
  const [settings, setSettings] = useState<LearningSettings | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void getLearningSettings(user.id)
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : "学习设置暂时无法读取。");
      });
    return () => {
      active = false;
    };
  }, [user]);

  async function save(next: LearningSettings) {
    if (!user) return;
    setSettings(next);
    setSaving(true);
    setMessage("");
    try {
      setSettings(await saveLearningSettings(user.id, next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "学习设置保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  if (!user) {
    return (
      <div className="settings-card">
        <h2>学习</h2>
        <p>登录后可以同步复习设置。</p>
      </div>
    );
  }

  return (
    <div className="settings-card">
      <h2>学习</h2>
      <p>设置会保存到云端，并在其他设备上立即生效。</p>
      {message && (
        <p className="notice notice-warning" role="status">
          {message}
        </p>
      )}
      {settings && (
        <>
          <label className="setting-row">
            <span>
              <b>每日新题上限</b>
              <small>每天最多把多少道新题加入复习队列。</small>
            </span>
            <input
              aria-label="每日新题上限"
              type="number"
              min={0}
              max={200}
              step={1}
              value={settings.dailyNewLimit}
              disabled={saving}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 0 && value <= 200)
                  void save({ ...settings, dailyNewLimit: value });
              }}
            />
          </label>
          <label className="setting-row">
            <span>
              <b>目标记忆保持率</b>
              <small>FSRS 排程目标，范围 0.80–0.95。</small>
            </span>
            <input
              aria-label="目标记忆保持率"
              type="number"
              min={0.8}
              max={0.95}
              step={0.01}
              value={settings.desiredRetention}
              disabled={saving}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 0.8 && value <= 0.95)
                  void save({ ...settings, desiredRetention: value });
              }}
            />
          </label>
          <label className="setting-row">
            <span>
              <b>暂停复习</b>
              <small>暂停后不显示复习队列角标，也不会继续排期。</small>
            </span>
            <input
              aria-label="暂停复习"
              type="checkbox"
              className="switch"
              role="switch"
              checked={settings.paused}
              disabled={saving}
              onChange={(event) => void save({ ...settings, paused: event.target.checked })}
            />
          </label>
          {saving && <p className="muted">正在保存…</p>}
        </>
      )}
    </div>
  );
}
