/**
 * The public declaration is intentionally conservative: it only communicates
 * that this web build was released alongside a durable organization processor.
 * It is not a worker health check and must never be used as proof that an
 * individual queue item is already running.
 */
export type OrganizationProcessorState = "not-deployed" | "declared";

/**
 * A deliberately narrow development aid for exercising the existing
 * browser-lifetime source/knowledge organization path before a durable
 * processor is deployed. This is never a worker declaration.
 */
export type LocalDevelopmentOrganizationRunnerState = "disabled" | "enabled";

export function organizationProcessorStateFromEnvironment(
  value = process.env.NEXT_PUBLIC_CONUO_ORGANIZATION_PROCESSOR_ENABLED,
): OrganizationProcessorState {
  return value === "true" ? "declared" : "not-deployed";
}

export function isOrganizationProcessorEnabled(state: OrganizationProcessorState): boolean {
  return state === "declared";
}

/**
 * `NEXT_PUBLIC_*` values are embedded into the client build. Keep the
 * environment check here as a second, explicit boundary: a production build
 * must never enable the local page-lifetime runner, even if its public flag
 * was mistakenly set to true.
 */
export function localDevelopmentOrganizationRunnerStateFromEnvironment(
  value = process.env.NEXT_PUBLIC_CONUO_LOCAL_ORGANIZATION_RUNNER_ENABLED,
  environment = process.env.NODE_ENV,
): LocalDevelopmentOrganizationRunnerState {
  return environment === "development" && value === "true" ? "enabled" : "disabled";
}

export function isLocalDevelopmentOrganizationRunnerEnabled(
  state: LocalDevelopmentOrganizationRunnerState,
): boolean {
  return state === "enabled";
}

export function localDevelopmentOrganizationRunnerAvailabilityMessage(): string {
  return "本地开发页面运行已启用：只能手动分析资料或生成主题草稿；刷新、关闭或离开页面会停止请求，不会创建后台任务或自动任务。";
}

export function organizationProcessorAvailabilityMessage(
  state: OrganizationProcessorState,
): string {
  return isOrganizationProcessorEnabled(state)
    ? "后台处理器已在当前构建声明启用。任务是否已被领取或完成，请刷新状态核对。"
    : "后台整理等待部署。当前构建不会创建新的资料分析、主题草稿或自动任务；已有记录仍可刷新、查看或停止。";
}
