// Grow either message textarea with its content, then scroll inside it once
// it reaches a comfortable reading height. Reset to auto before measuring so
// deleting text also shrinks a previously expanded composer.
export const COMPOSER_MAX_HEIGHT = 240;
export const COMPOSER_MIN_HEIGHT = 48;

export const COMPOSER_TOOLBAR_HEIGHT = 47;
export const COMPOSER_ATTACHMENTS_HEIGHT = 140;
// Minimum vertical room reserved above `.terminal-composer` inside `.console-layout`
// (`112px` `.terminal-body` top padding for the floating companion/toolbar +
// `25px` `.repo-row` + breathing room) so `.terminal-composer` never overflows
// under the virtual keyboard on short mobile viewports.
export const COMPOSER_MIN_VIEWPORT_CLEARANCE = 148;

export function resizeComposerTextarea(
  input: Pick<HTMLTextAreaElement, "style" | "scrollHeight"> & { parentElement?: HTMLElement | null },
  availableLayoutHeight?: number,
): void {
  const hasAttachments = Boolean(input.parentElement?.querySelector?.(".composer-attachments"));
  const attachmentsHeight = hasAttachments ? COMPOSER_ATTACHMENTS_HEIGHT : 0;
  const layoutHeight =
    availableLayoutHeight ??
    input.parentElement?.closest?.(".console-layout")?.clientHeight ??
    0;
  const effectiveMaxHeight =
    layoutHeight > 0
      ? Math.max(
          COMPOSER_MIN_HEIGHT,
          Math.min(
            COMPOSER_MAX_HEIGHT,
            layoutHeight - COMPOSER_MIN_VIEWPORT_CLEARANCE - COMPOSER_TOOLBAR_HEIGHT - attachmentsHeight,
          ),
        )
      : COMPOSER_MAX_HEIGHT;
  input.style.height = "auto";
  const contentHeight = input.scrollHeight;
  const clampedHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.min(contentHeight, effectiveMaxHeight));
  const nextHeight = `${clampedHeight}px`;
  input.style.height = nextHeight;
  input.style.overflowY = contentHeight > effectiveMaxHeight ? "auto" : "hidden";
}
