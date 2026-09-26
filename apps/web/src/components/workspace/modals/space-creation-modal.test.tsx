// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyWorkspace } from "@/lib/seed";
import SpaceCreationModal from "./space-creation-modal";
import SpacesPane from "../sections/settings/spaces-pane";

describe("space creation quota guard", () => {
  let host: HTMLDivElement;
  let root: Root;
  const update = vi.fn(() => true);
  const ensureCanActivateSpace = vi.fn(async () => false);
  const setToast = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    update.mockClear();
    ensureCanActivateSpace.mockClear().mockResolvedValue(false);
    setToast.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the form input and saved workspace untouched when quota is full", async () => {
    const data = createEmptyWorkspace();
    await act(async () =>
      root.render(
        createElement(SpaceCreationModal, {
          spaceCreationIntent: "browse",
          data,
          update,
          setToast,
          setSpaceCreationIntent: vi.fn(),
          setImportTargetSpaceId: vi.fn(),
          setModal: vi.fn(),
          ensureCanActivateSpace,
          chooseSpace: vi.fn(),
          closeSpaceCreation: vi.fn(),
        }),
      ),
    );
    const input = host.querySelector<HTMLInputElement>('input[name="name"]')!;
    input.value = "新的空间";
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    expect(ensureCanActivateSpace).toHaveBeenCalledWith(1);
    expect(update).not.toHaveBeenCalled();
    expect(input.value).toBe("新的空间");
  });

  it("checks the quota before restoring an archived space", async () => {
    const data = createEmptyWorkspace();
    data.spaces[0].archived = true;
    await act(async () =>
      root.render(
        createElement(SpacesPane, {
          data,
          update,
          setSpaceToDeleteId: vi.fn(),
          setToast,
          setModal: vi.fn(),
          openSpaceCreation: vi.fn(),
          ensureCanActivateSpace,
          chooseSpace: vi.fn(),
        }),
      ),
    );
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("恢复空间"))
        ?.click();
    });
    expect(ensureCanActivateSpace).toHaveBeenCalledWith(1);
    expect(update).not.toHaveBeenCalled();
  });
});
