import { describe, expect, it } from "vitest";
import {
  formatWorkspaceSectionRoute,
  isKnowledgeLibraryFilter,
  isWorkspaceSection,
  isScopedWorkspaceSection,
  parseWorkspaceSectionRoute,
} from "./workspace-section-route";

describe("workspace section route", () => {
  it("round-trips a space-scoped screen through a refresh-safe fragment", () => {
    const route = formatWorkspaceSectionRoute("knowledge", "machine_learning-01");

    expect(route).toBe("#knowledge?space=machine_learning-01");
    expect(parseWorkspaceSectionRoute(route)).toEqual({
      section: "knowledge",
      spaceId: "machine_learning-01",
    });
  });

  it("round-trips knowledge search and review state without writing defaults", () => {
    const route = formatWorkspaceSectionRoute("knowledge", "machine_learning-01", {
      query: "学习率 与 梯度",
      knowledgeFilter: "pending",
    });

    expect(route).toBe(
      "#knowledge?space=machine_learning-01&q=%E5%AD%A6%E4%B9%A0%E7%8E%87+%E4%B8%8E+%E6%A2%AF%E5%BA%A6&status=pending",
    );
    expect(parseWorkspaceSectionRoute(route)).toEqual({
      section: "knowledge",
      spaceId: "machine_learning-01",
      query: "学习率 与 梯度",
      knowledgeFilter: "pending",
    });
    expect(formatWorkspaceSectionRoute("knowledge", "all", { knowledgeFilter: "all" })).toBe(
      "#knowledge",
    );
  });

  it("ignores malformed knowledge state and does not leak it into other sections", () => {
    expect(parseWorkspaceSectionRoute("#knowledge?q=%20%20&status=unknown")).toEqual({
      section: "knowledge",
      spaceId: "all",
    });
    expect(parseWorkspaceSectionRoute("#notes?q=private&status=pending")).toEqual({
      section: "notes",
      spaceId: "all",
    });
    expect(isKnowledgeLibraryFilter("saved")).toBe(true);
    expect(isKnowledgeLibraryFilter("draft")).toBe(false);
  });

  it("keeps global screens compact and treats malformed space ids as all spaces", () => {
    expect(formatWorkspaceSectionRoute("questions", "all")).toBe("#questions");
    expect(parseWorkspaceSectionRoute("#questions?space=not%20a%20space")).toEqual({
      section: "questions",
      spaceId: "all",
    });
  });

  it("does not claim source, note, and library routes", () => {
    expect(parseWorkspaceSectionRoute("#library/space-a")).toBeUndefined();
    expect(parseWorkspaceSectionRoute("#source/source-a")).toBeUndefined();
    expect(isScopedWorkspaceSection("library")).toBe(false);
    expect(isScopedWorkspaceSection("home")).toBe(true);
  });

  it("keeps the task center global when it is bookmarked from a learning space", () => {
    expect(formatWorkspaceSectionRoute("tasks", "machine_learning-01")).toBe("#tasks");
    expect(parseWorkspaceSectionRoute("#tasks?space=machine_learning-01")).toEqual({
      section: "tasks",
      spaceId: "all",
    });
    expect(isWorkspaceSection("tasks")).toBe(true);
    expect(isScopedWorkspaceSection("tasks")).toBe(false);
  });
});
