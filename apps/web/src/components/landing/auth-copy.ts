/**
 * Strings for the account dialog. Kept apart from the homepage copy so the
 * always-loaded cloud entry does not pull the whole landing text into its bundle.
 */
export type Lang = "zh" | "en";
/** "start" is the homepage's single entry: the login form with a neutral title. */
export type AuthMode = "start" | "login" | "signup";

export interface AuthCopy {
  label: string;
  titles: Record<"start" | "login" | "signup" | "reset" | "unavailable", string>;
  startLead: string;
  lead: string;
  resetLead: string;
  unavailable: string;
  retry: string;
  close: string;
  tagline: string;
  flow: string[];
  /** Shown when the dialog language differs from the (Chinese-only) workspace UI. */
  localeNote: string;
}

export const authCopy: Record<Lang, AuthCopy> = {
  zh: {
    label: "云端学习工作区",
    titles: {
      start: "开始使用 Conuo",
      login: "登录，继续学习",
      signup: "创建你的学习空间",
      reset: "找回密码",
      unavailable: "云端服务暂不可用",
    },
    startLead: "登录已有账号，或注册一个新账号。资料、笔记与学习记录统一保存在云端。",
    lead: "资料、笔记与学习记录统一保存至云端，登录后即可继续。",
    resetLead: "输入注册时使用的邮箱，我们会发送重置密码的链接。",
    unavailable: "请检查网络或联系管理员确认云端配置，然后重试。",
    retry: "重新连接",
    close: "关闭",
    tagline: "每个答案，都有出处。",
    flow: ["收集资料", "阅读提问", "核对原文", "保存理解", "继续学习"],
    localeNote: "",
  },
  en: {
    label: "Cloud study workspace",
    titles: {
      start: "Get started with Conuo",
      login: "Log in to keep learning",
      signup: "Create your study space",
      reset: "Reset your password",
      unavailable: "Cloud service unavailable",
    },
    startLead:
      "Log in, or create a new account. Sources, notes and learning history are stored in the cloud.",
    lead: "Sources, notes and learning history are stored in the cloud. Log in to continue.",
    resetLead: "Enter the email you signed up with and we'll send a reset link.",
    unavailable:
      "Check your connection or ask an administrator to verify the cloud configuration, then retry.",
    retry: "Reconnect",
    close: "Close",
    tagline: "Every answer, with its source.",
    flow: ["Collect", "Read & ask", "Verify", "Keep", "Continue"],
    localeNote: "The workspace is currently available in Simplified Chinese.",
  },
};
