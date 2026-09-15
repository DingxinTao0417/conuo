import { useEffect, type RefObject } from "react";

/**
 * Closes a popover menu on an outside press or Escape.
 *
 * `container` has to wrap both the trigger and the popover: pressing the
 * trigger again must toggle the menu rather than be seen as an outside press,
 * which would close and immediately reopen it.
 */
export function useMenuDismissal(
  open: boolean,
  container: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, container, open]);
}
