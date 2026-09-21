import { ClientError, type Identity } from "./api.ts";
import { isTransientAuthError } from "./session-fence.ts";

/** Resolve a request credential without mistaking unavailable Auth for another owner. */
export function createRequestIdentity(options: {
  owner: string;
  isCurrent: () => boolean;
  isFenceBlocked: () => Promise<boolean>;
  getSession: () => Promise<{
    data: { session: { user: { id: string }; access_token: string } | null };
    error: { status?: number } | null;
  }>;
}): () => Promise<Identity | null> {
  const reauthenticate = () =>
    new ClientError(
      "登录需要重新验证，未保存输入会受保护。",
      401,
      "UNAUTHENTICATED",
    );
  const temporary = () =>
    new ClientError(
      "暂时无法确认登录连接，请联网后重试。当前输入仍保留。",
      503,
      "AUTH_TEMPORARILY_UNAVAILABLE",
    );
  async function fenced() {
    try {
      return await options.isFenceBlocked();
    } catch {
      throw reauthenticate();
    }
  }
  return async () => {
    if (!options.isCurrent()) return null;
    if (await fenced()) throw reauthenticate();
    if (!options.isCurrent()) return null;
    let result: Awaited<ReturnType<typeof options.getSession>>;
    try {
      result = await options.getSession();
    } catch (cause) {
      if (!options.isCurrent()) return null;
      const failure =
        cause && typeof cause === "object"
          ? (cause as { status?: number })
          : {};
      if (failure.status === 423)
        throw new ClientError(
          "当前账号已停止访问。",
          423,
          "ACCOUNT_DELETION_PENDING",
        );
      if (isTransientAuthError(failure)) throw temporary();
      throw reauthenticate();
    }
    if (!options.isCurrent()) return null;
    if (await fenced()) throw reauthenticate();
    if (!options.isCurrent()) return null;
    if (result.error) {
      if (result.error.status === 423)
        throw new ClientError(
          "当前账号已停止访问。",
          423,
          "ACCOUNT_DELETION_PENDING",
        );
      if (isTransientAuthError(result.error)) throw temporary();
      throw reauthenticate();
    }
    const session = result.data.session;
    if (!session) throw reauthenticate();
    if (session.user.id !== options.owner) return null;
    if (!session.access_token) throw reauthenticate();
    return { userId: session.user.id, accessToken: session.access_token };
  };
}
