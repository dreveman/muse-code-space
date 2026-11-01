# Detailed Plan: `AskRichUserInput` Multi-Step Wizard & Scratchpad Tab

## 1. Overview & Goals

Companions in Code Space currently have access to a basic `request_user_input` tool that presents a flat list of multiple-choice or single-line text questions. For design, UI layout, architecture, and interactive debugging tasks, companions need a richer way to gather structured multi-modal input from the user.

This plan introduces:
1. **`AskRichUserInput` (`mcp__code_space__ask_rich_user_input`)**: A per-session MCP tool that lets a companion ask the user a sequence of **multi-step inputs** (`choice`, `text`, `image`, and `sketch`) and pauses the turn (`needs_you = true`) until the user completes or skips the wizard.
2. **Multi-Step Wizard UI (`RichUserInputCard`)**: A step-by-step interactive card above the conversation composer with step indicators, `Back` / `Next` navigation, per-step validation, image upload/paste, and direct integration with the Scratchpad.
3. **Scratchpad Side Panel Tab (`ScratchpadPanel.tsx` & `SidePanel.tsx`)**: A dedicated drawing and wireframing canvas tab in the side panel (alongside Smart Log, Preview, and Terminal) optimized for touch, iPad Apple Pencil, and iPhone/foldable stylus input (`PointerEvent` coalesced strokes, pressure sensitivity, palm-rejection `Pen only` mode, freehand pen, highlighter, line/arrow/rect/circle shapes, text labels, grid/dot/blank guides, and undo/redo).

---

## 2. Tool Schema (`mcp__code_space__ask_rich_user_input`)

Registered in `pilot/mcp.mjs` (`MCP_TOOLS`):

```json
{
  "name": "ask_rich_user_input",
  "title": "AskRichUserInput",
  "description": "Ask the user a multi-step sequence of rich inputs (single/multiple choice, free-form text, image upload, or a hand-drawn sketch/wireframe from the Scratchpad) and wait for their answers.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "Optional heading for the multi-step input wizard."
      },
      "steps": {
        "type": "array",
        "minItems": 1,
        "maxItems": 8,
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "header": { "type": "string", "description": "Short step label (e.g. 'Layout sketch', 'Color palette')." },
            "question": { "type": "string", "description": "Detailed prompt for this step." },
            "kind": {
              "type": "string",
              "enum": ["choice", "text", "image", "sketch"],
              "description": "Input type for this step: 'choice' (options), 'text' (multi-line text), 'image' (upload/paste photo or screenshot), or 'sketch' (draw in the Scratchpad)."
            },
            "required": { "type": "boolean" },
            "placeholder": { "type": "string" },
            "selection": {
              "type": "object",
              "properties": {
                "mode": { "type": "string", "enum": ["single", "multiple"] },
                "minSelections": { "type": "integer" },
                "maxSelections": { "type": "integer" }
              }
            },
            "options": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "label": { "type": "string" },
                  "description": { "type": "string" },
                  "preview": { "type": "string" }
                },
                "required": ["label"]
              }
            },
            "canvasPreset": {
              "type": "object",
              "properties": {
                "background": { "type": "string", "enum": ["grid", "dots", "blank"] }
              }
            }
          },
          "required": ["id", "question"]
        }
      }
    },
    "required": ["steps"]
  }
}
```

---

## 3. End-to-End Transport & Persistence

1. **Pilot MCP & User Input Bridge (`pilot/mcp.mjs`, `pilot/pilot.mjs`)**:
   - When an agent calls `ask_rich_user_input`:
     - The pilot creates a pending input entry (`userInputId = "rich-" + uuidv7()`) in `pendingRichInputs` associated with the calling session.
     - Each step is normalized into the `questions` array with rich metadata (`kind`, `required`, `placeholder`, `canvasPreset`) so existing `GET /sessions/:id/user-inputs` and `user_input_requested` events carry it without breaking legacy callers.
     - The MCP `tools/call` request awaits a Promise stored on the `pendingRichInputs` entry.
   - When the user submits answers via `POST /sessions/:id/user-inputs/answer`:
     - Each answer item can carry `{ questionId, selectedLabels, freeText, note, attachment?: { name, mediaType, base64Data } }`.
     - If an `attachment` (e.g. a PNG drawing from the Scratchpad or an uploaded image) is present, the pilot saves it into the session workspace under `.code-space/inputs/<questionId>-<timestamp>.png` and records the relative workspace path (`savedPath`).
     - The held MCP `tools/call` resolves with a structured summary of all step answers (including the workspace file paths of any saved sketches/images so the companion can read them with `read_file` or display them in Markdown).
2. **Server Actions (`server/src/actions.ts`)**:
   - Extend `getPendingUserInputs` response schema to include optional `title` and per-question `kind`, `required`, `placeholder`, and `canvasPreset`.
   - Extend `answerUserInput` request schema so each answer can include an optional `attachment` (`{ name, mediaType, base64Data }`).

---

## 4. Scratchpad Side Panel Tab (`client/src/ScratchpadPanel.tsx`, `client/src/SidePanel.tsx`)

1. **Side Panel Integration**:
   - Add `{ key: string; kind: "scratchpad" }` to `SideTab` in `client/src/SidePanel.tsx`.
   - Add `<NewScratchpadButton />` in the floating chat toolbar (`client/src/App.tsx`) next to Smart Log, Preview, and Terminal.
   - On narrow/mobile viewports (iPhone, portrait iPad Split View), opening the Scratchpad enters the full-screen mobile side panel with a `Back to conversation` button.
2. **Touch, Apple Pencil & Stylus Canvas**:
   - Uses HTML5 `<canvas>` with `devicePixelRatio` scaling and `touch-action: none`.
   - Uses `PointerEvent` (`onPointerDown`, `onPointerMove`, `onPointerUp`) and `event.getCoalescedEvents()` for low-latency high-precision stylus curves.
   - Modulates stroke width using `event.pressure` when `event.pointerType === "pen"`.
   - Includes a **Pen only (palm rejection)** toggle (auto-suggested when a `"pen"` pointer is seen) so iPad/stylus users can rest their hand on the screen while drawing.
3. **Tools & Actions**:
   - **Tools**: Freehand Pen, Highlighter, Line, Arrow, Rectangle, Circle, Text label, and Eraser.
   - **Style controls**: 7-color palette, 3 stroke widths, and switchable background (`Grid`, `Dots`, `Blank`).
   - **History**: Undo (`Cmd/Ctrl+Z`), Redo (`Cmd/Ctrl+Shift+Z`), and Clear.
   - **Output**:
     - When a `sketch` or `image` step in `RichUserInputCard` is waiting for input, a primary **"Use in Step"** button exports the composite canvas as a PNG (`image/png`) into that wizard step (and returns to the conversation view on mobile).
     - At any other time, **"Attach to message"** attaches the PNG drawing directly to the active conversation composer's attachments bar.

---

## 5. Multi-Step Wizard Card (`client/src/RichUserInputCard.tsx`)

- Replaces the flat `UserInputCard` when `steps` use multi-step navigation or rich input kinds (`sketch`, `image`, `text`, `choice`):
  - **Step Indicator Bar**: Numbered step pills showing progress and completion status; clicking any pill jumps to that step.
  - **Active Step Pane**:
    - `choice`: Radio/checkbox option cards with optional preview blocks + free-text fallback.
    - `text`: Auto-focused multi-line `<textarea>` with character count.
    - `image`: File picker + clipboard paste + thumbnail preview.
    - `sketch`: **"Open Scratchpad to Draw"** button (which opens the Scratchpad side panel tab and links its output to this step) + live thumbnail preview of the current drawing + optional caption/notes field + fallback image upload.
  - **Navigation Footer**: `Skip`, `Back`, `Next step`, and `Send answers` (enabled when all required steps are answered).
