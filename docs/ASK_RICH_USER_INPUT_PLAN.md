# Detailed Plan: `AskUserRichForm` & Scratchpad Tab

## 1. Overview & Contract

`AskUserRichForm` (`mcp__code_space__AskUserRichForm`) handles mixed user input across 1–4 questions.

### Question Kinds (`1–4` questions)
1. **`choice`**: Picker with 2–4 options plus **Other** (free-form text fallback).
2. **`text`**: Free-form written answer.
3. **`file`**: One uploaded image, PDF, or text file (or a sketch drawn in the Scratchpad). Saved into `.code-space/inputs/` inside the session workspace.
4. **`embed`**: A custom UI that a specific client renders (such as `embed: { type: "scratchpad" }` in Code Space, which opens the Scratchpad canvas and writes the resulting PNG into `.code-space/inputs/`). Clients that do not recognize the custom embed UI render it as a plain text question.

### Timeout
- **Default**: 3 minutes (`180000` ms / `180` seconds).
- **Configurable**: Can be changed via `timeout`. Setting `timeout: null` waits forever (only when the user has asked the companion to wait).

### Return Value
- **User submits**:
  ```json
  {
    "answered": true,
    "answers": {
      "<question text>": "<your pick, text, or saved workspace file path>"
    }
  }
  ```
- **User declines or cancels (`Skip`)**:
  The companion stops (`turn/interrupt`) and waits for the user's next message (`{"answered": false, "declined": true, "answers": {}}`).
- **Timeout (3 minutes by default)**:
  Returns `{"answered": false, "timedOut": true, "answers": {}}` so the companion proceeds on its best judgment and does not ask again.

### When Companions Use `AskUserRichForm`
- Only when blocked on a decision that is the user's to make — something that cannot be worked out from the code, the conversation, or a sensible default.

---

## 2. Scratchpad Side Panel Tab (`client/src/ScratchpadPanel.tsx`, `client/src/SidePanel.tsx`)

- **Side Panel Integration**: `{ key: "scratchpad", kind: "scratchpad" }` tab in `SidePanel.tsx`, plus `<NewScratchpadButton />` in the floating conversation toolbar.
- **Touch, Apple Pencil & Stylus Canvas**:
  - HTML5 `<canvas>` with `devicePixelRatio` scaling and `touch-action: none`.
  - `PointerEvent` + `getCoalescedEvents()` with Apple Pencil pressure sensitivity (`event.pressure` when `pointerType === "pen"`).
  - **Pen only (palm rejection)** toggle.
  - Tools: Pen, Marker, Line, Arrow, Box, Oval, Eraser; 7 colors; 3 stroke sizes; Grid / Dots / Blank guides; Undo / Redo / Clear / Save PNG.
  - Exports directly into an active `AskUserRichForm` `file` or `embed` (`scratchpad`) question or attaches to the conversation composer.
