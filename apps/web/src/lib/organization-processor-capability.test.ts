import { describe, expect, it } from "vitest";
import {
  isLocalDevelopmentOrganizationRunnerEnabled,
  isOrganizationProcessorEnabled,
  localDevelopmentOrganizationRunnerAvailabilityMessage,
  localDevelopmentOrganizationRunnerStateFromEnvironment,
  organizationProcessorAvailabilityMessage,
  organizationProcessorStateFromEnvironment,
} from "./organization-processor-capability";

describe("organization processor capability declaration", () => {
  it("only treats the exact public true value as a released processor declaration", () => {
    expect(organizationProcessorStateFromEnvironment(undefined)).toBe("not-deployed");
    expect(organizationProcessorStateFromEnvironment("TRUE")).toBe("not-deployed");
    expect(organizationProcessorStateFromEnvironment("false")).toBe("not-deployed");
    expect(organizationProcessorStateFromEnvironment("true")).toBe("declared");
  });

  it("only enables the local page runner for the exact public value in development", () => {
    expect(localDevelopmentOrganizationRunnerStateFromEnvironment(undefined, "development")).toBe(
      "disabled",
    );
    expect(localDevelopmentOrganizationRunnerStateFromEnvironment("TRUE", "development")).toBe(
      "disabled",
    );
    expect(localDevelopmentOrganizationRunnerStateFromEnvironment("true", "test")).toBe("disabled");
    expect(localDevelopmentOrganizationRunnerStateFromEnvironment("true", "production")).toBe(
      "disabled",
    );
    expect(localDevelopmentOrganizationRunnerStateFromEnvironment("true", "development")).toBe(
      "enabled",
    );
    expect(isLocalDevelopmentOrganizationRunnerEnabled("disabled")).toBe(false);
    expect(isLocalDevelopmentOrganizationRunnerEnabled("enabled")).toBe(true);
    expect(localDevelopmentOrganizationRunnerAvailabilityMessage()).toContain("不会创建后台任务");
  });

  it("keeps an undeclared build fail-closed in its user-facing capability copy", () => {
    expect(isOrganizationProcessorEnabled("not-deployed")).toBe(false);
    expect(organizationProcessorAvailabilityMessage("not-deployed")).toContain(
      "不会创建新的资料分析、主题草稿或自动任务",
    );
    expect(isOrganizationProcessorEnabled("declared")).toBe(true);
  });
});
