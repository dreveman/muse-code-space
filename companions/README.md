# Companion roster

Five built-in companions are available on a fresh install. Users can create more with the **Create companion** flow in the sidebar; custom companions are stored in the app database (`custom_companions`), borrow artwork from the catalog below, and get the fixed minimal SOUL template from `client/src/companionCustom.ts`. Jolly and Muse are reserved for the user's assistant.

Ratings are **Speed / Thoughtfulness / Creativity / Initiative**, each from 1 to 5. They are computed from model and effort by `computeCompanionStats` in `server/src/companionModels.ts` — never authored or stored. They describe relative strengths informed by model and effort, rather than measured performance. A low rating describes a preference, not permission to skip necessary checks. Initiative never changes authorization requirements.

| Name and soul | Character | Specialty | Ratings | Model | Effort | Trade-off |
| --- | --- | --- | --- | --- | --- | --- |
| [Poppy](poppy/SOUL.md) | [Beach hedgehog](../client/src/assets/companions/poppy/still.png) | dependable all-rounder | 3 / 2 / 2 / 4 | Spark 1.3 | medium | Balances speed and depth, so the most difficult problems may call for a deeper specialist. |
| [Remy](remy/SOUL.md) | [Chipmunk](../client/src/assets/companions/remy/still.png) | tidy organizer | 4 / 1 / 2 / 4 | Spark 1.3 | low | Prefers proven patterns and small, safe steps, so unconventional designs may need a more adventurous companion. |
| [Tilly](tilly/SOUL.md) | [Pink detective bird](../client/src/assets/companions/tilly/still.png) | curious tester | 2 / 3 / 2 / 3 | Spark 1.3 | xhigh | Spends extra time exploring scenarios before calling work finished, trading speed for broader confidence. |
| [Nova](nova/SOUL.md) | [Cool cat](../client/src/assets/companions/nova/still.png) | inventive explorer | 2 / 4 / 4 / 5 | Wonder 1.0 | medium | Explores several possibilities before settling on one, so routine fixes may take longer than with a direct companion. |
| [Sage](sage/SOUL.md) | [Scientist rabbit](../client/src/assets/companions/sage/still.png) | patient researcher | 1 / 5 / 5 / 2 | Wonder Full 1.0 | max | Deliberates thoroughly on difficult problems, which makes simple questions feel slower. |

The other 15 catalog entries (Pip, Juno, Milo, Ziggy, Bea, Kit, Luna, Otto, Iris, Finn, Echo, Bo, Rio, Mochi, Ember) are artwork donors for custom companions. They are not assignable, but their names stay reserved and tasks created with them before this roster keep their artwork.

## Definitions and assets

- [catalog.json](catalog.json) defines companion identity, card copy, skills, model/effort defaults, and repository-relative animation paths. Ratings are not in the catalog; they are computed from model and effort.
- Each companion's `SOUL.md` describes its behavior. The catalog's `soulPath` is relative to this directory. The app displays this content on the companion card; it does not yet apply it to the pilot's runtime instructions.
- Every companion has four 256 × 256 WebP animations in `client/src/assets/companions/<id>/`: `idle.webp` for full-body cards, `portrait-idle.webp` for the sidebar and conversation, `waking.webp` for starting a task, and `working.webp` for typing at a laptop with the desk retained. `client/src/companionArtwork.ts` imports the assets as bundled URLs and the souls as text.
- Card and portrait idle images have separate required slots: `cardIdle` and `portraitIdle`. `card-still.png` supplies the full-body `cardStill` fallback; `still.png` supplies the portrait fallback used when motion is disabled and for archived tasks. These stills match the first frame of their respective idle animations.
- All animation backgrounds use RGB (248, 248, 248), the nearest 8-bit value to 0.973 per channel. Idle and Working loop; wake-up plays once and finishes on the portrait idle pose.
- Both idle views include gentle head and upper-body movement with the existing blinks. Full-body feet and contact shadows stay planted. Pip wakes with a brief left–right head shake; other companions retain their gentle eye-opening wake-up.
- Twelve companions prefer `muse-spark-1.3`, with the existing catalog fallback. Nova, Bea, Iris, and Ember require `muse-wonder-1.0`; Kit, Luna, Otto, and Sage require `muse-wonder-full-1.0`. Effort settings span minimal, low, medium, high, xhigh, and max.
- The pilot's live `/models` catalog is already filtered by payment and entitlement. A missing required model shows **Upgrade required** with a link to [Muse Model API billing](https://dev.meta.ai/billing). Wonder companions never fall back to another model. A failed catalog read means access is unknown, not that an upgrade is required.
- The client refreshes model access while open and when returning from billing. Server actions recheck live access before creating or assigning a paid companion; paid starts, turns, and task restoration also check the saved model. Existing tasks keep their stored model and effort until handed over.

## Task assignment

The sidebar shows available companions and companions assigned to tasks. Picking a companion displays its card; sending the first message starts a task. The five built-ins come first, then user-created companions, with a **Create companion** row below the last companion.

The runtime associates companions with sessions by canonical name. An unarchived task occupies its companion, including when idle. Archiving the task releases the companion. A handoff assigns an available companion while preserving the conversation, working directory, project, and task summary. Resuming an archived task requires an available companion, checked again by the server.

Task renaming and Muse-authored descriptions use the same `session_summary` field. They do not rename the companion. Built-in companion definitions are read-only in the UI; custom companions are created (create-only in this version) through the create card.

For local setup and testing, see [LOCAL_DEVELOPMENT.md](../docs/LOCAL_DEVELOPMENT.md).
