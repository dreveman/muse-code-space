# Companion roster

The app includes 20 companions. Each has a name, character, working style, skills, ratings, model preference, effort setting, and SOUL.md. Jolly and Muse are reserved for the user's assistant.

Ratings are **Speed / Thoughtfulness / Creativity / Initiative**, each from 1 to 5. They describe relative strengths across the roster, informed by model, effort, and working style, rather than measured performance. A low rating describes a preference, not permission to skip necessary checks. Initiative never changes authorization requirements.

| Name and soul | Character | Specialty | Ratings | Model | Effort | Trade-off |
| --- | --- | --- | --- | --- | --- | --- |
| [Pip](pip/SOUL.md) | [Rabbit](../client/src/assets/companions/pip/still.png) | dependable all-rounder | 3 / 2 / 2 / 4 | Spark 1.3 | medium | Balances speed and depth, so difficult problems may need a more exhaustive specialist. |
| [Juno](juno/SOUL.md) | [Gray bird](../client/src/assets/companions/juno/still.png) | clear communicator | 3 / 2 / 3 / 2 | Spark 1.3 | medium | Spends more time shaping explanations and examples than a terse implementer. |
| [Milo](milo/SOUL.md) | [Puppy](../client/src/assets/companions/milo/still.png) | encouraging guide | 4 / 1 / 2 / 1 | Spark 1.3 | low | Keeps guidance quick and approachable; difficult problems need a deeper investigation. |
| [Nova](nova/SOUL.md) | [Cool cat](../client/src/assets/companions/nova/still.png) | inventive explorer | 2 / 4 / 5 / 5 | Wonder 1.0 | high | Explores more possibilities and may need a scope check before polishing one. |
| [Ziggy](ziggy/SOUL.md) | [Zebra](../client/src/assets/companions/ziggy/still.png) | quick fixer | 5 / 1 / 1 / 5 | Spark 1.3 | minimal | Optimizes for tiny, obvious fixes with very little deliberation; complex work needs a deeper pass. |
| [Bea](bea/SOUL.md) | [Beaver](../client/src/assets/companions/bea/still.png) | practical builder | 3 / 4 / 2 / 5 | Wonder 1.0 | high | Prefers established patterns over adventurous designs. |
| [Kit](kit/SOUL.md) | [Raccoon](../client/src/assets/companions/kit/still.png) | resourceful detective | 2 / 5 / 4 / 5 | Wonder Full 1.0 | xhigh | Invests in tracing and reproduction before attempting a fix. |
| [Remy](remy/SOUL.md) | [Chipmunk](../client/src/assets/companions/remy/still.png) | tidy organizer | 4 / 1 / 1 / 4 | Spark 1.3 | low | Moves quickly on familiar cleanup patterns, with little exploration of alternatives. |
| [Luna](luna/SOUL.md) | [Owl](../client/src/assets/companions/luna/still.png) | careful reviewer | 1 / 5 / 3 / 2 | Wonder Full 1.0 | xhigh | Takes longer and may surface more issues than a quick implementation pass. |
| [Otto](otto/SOUL.md) | [Elephant](../client/src/assets/companions/otto/still.png) | systems thinker | 1 / 5 / 5 / 4 | Wonder Full 1.0 | max | Uses maximum deliberation on system-wide decisions, trading speed for a thorough design pass. |
| [Iris](iris/SOUL.md) | [Fluffy bow helper](../client/src/assets/companions/iris/still.png) | thoughtful designer | 3 / 4 / 5 / 2 | Wonder 1.0 | medium | Spends extra attention on presentation and interaction details. |
| [Finn](finn/SOUL.md) | [Frog](../client/src/assets/companions/finn/still.png) | playful experimenter | 5 / 1 / 4 / 5 | Spark 1.3 | low | Prioritizes learning quickly; successful experiments may need a finishing pass. |
| [Echo](echo/SOUL.md) | [Green parrot](../client/src/assets/companions/echo/still.png) | cautious troubleshooter | 1 / 3 / 1 / 3 | Spark 1.3 | xhigh | Examines failure scenarios that can slow down a straightforward happy-path change. |
| [Poppy](poppy/SOUL.md) | [Beach hedgehog](../client/src/assets/companions/poppy/still.png) | friendly finisher | 5 / 1 / 3 / 4 | Spark 1.3 | minimal | Spends little time deliberating over small finishing touches; deeper logic and structural changes need a slower pass. |
| [Sage](sage/SOUL.md) | [Scientist rabbit](../client/src/assets/companions/sage/still.png) | patient researcher | 1 / 5 / 4 / 2 | Wonder Full 1.0 | max | Uses maximum deliberation for difficult investigations, making simple questions feel slow. |
| [Bo](bo/SOUL.md) | [Sloth](../client/src/assets/companions/bo/still.png) | steady simplifier | 2 / 3 / 2 / 1 | Spark 1.3 | high | Works deliberately and favors restraint over rapid experimentation. |
| [Rio](rio/SOUL.md) | [Aviator dog](../client/src/assets/companions/rio/still.png) | steady navigator | 2 / 3 / 2 / 5 | Spark 1.3 | high | Spends time sequencing and checking dependencies before moving ahead; small isolated fixes may feel slower. |
| [Mochi](mochi/SOUL.md) | [Plush monkey](../client/src/assets/companions/mochi/still.png) | nimble tinkerer | 5 / 1 / 4 / 4 | Spark 1.3 | low | Favors quick, focused solutions over exhaustive design; lasting infrastructure needs a more deliberate pass. |
| [Tilly](tilly/SOUL.md) | [Pink detective bird](../client/src/assets/companions/tilly/still.png) | curious tester | 1 / 3 / 3 / 3 | Spark 1.3 | xhigh | Explores extra scenarios and reproductions before calling work finished, trading speed for broader confidence. |
| [Ember](ember/SOUL.md) | [Orange fox](../client/src/assets/companions/ember/still.png) | clever problem-solver | 2 / 4 / 4 / 4 | Wonder 1.0 | high | Spends time comparing approaches before choosing a practical solution; tiny routine fixes may feel slower. |

## Definitions and assets

- [catalog.json](catalog.json) defines companion identity, card copy, skills, ratings, model/effort defaults, and repository-relative animation paths.
- Each companion's `SOUL.md` describes its behavior. The catalog's `soulPath` is relative to this directory. The app displays this content on the companion card; it does not yet apply it to the pilot's runtime instructions.
- Every companion has four 256 × 256 WebP animations in `client/src/assets/companions/<id>/`: `idle.webp` for full-body cards, `portrait-idle.webp` for the sidebar and conversation, `waking.webp` for starting a task, and `working.webp` for typing at a laptop with the desk retained. `client/src/companionArtwork.ts` imports the assets as bundled URLs and the souls as text.
- Card and portrait idle images have separate required slots: `cardIdle` and `portraitIdle`. `card-still.png` supplies the full-body `cardStill` fallback; `still.png` supplies the portrait fallback used when motion is disabled and for archived tasks. These stills match the first frame of their respective idle animations.
- All animation backgrounds use RGB (248, 248, 248), the nearest 8-bit value to 0.973 per channel. Idle and Working loop; wake-up plays once and finishes on the portrait idle pose.
- Both idle views include gentle head and upper-body movement with the existing blinks. Full-body feet and contact shadows stay planted. Pip wakes with a brief left–right head shake; other companions retain their gentle eye-opening wake-up.
- Twelve companions prefer `muse-spark-1.3`, with the existing catalog fallback. Nova, Bea, Iris, and Ember require `muse-wonder-1.0`; Kit, Luna, Otto, and Sage require `muse-wonder-full-1.0`. Effort settings span minimal, low, medium, high, xhigh, and max.
- The pilot's live `/models` catalog is already filtered by payment and entitlement. A missing required model shows **Upgrade required** with a link to [Muse Model API billing](https://dev.meta.ai/billing). Wonder companions never fall back to another model. A failed catalog read means access is unknown, not that an upgrade is required.
- The client refreshes model access while open and when returning from billing. Server actions recheck live access before creating or assigning a paid companion; paid starts, turns, and task restoration also check the saved model. Existing tasks keep their stored model and effort until handed over.

## Task assignment

The sidebar shows available companions and companions assigned to tasks. Picking a companion displays its card; sending the first message starts a task. The first five roster entries form the default selection, with **More companions** revealing the rest.

The runtime associates companions with sessions by canonical name. An unarchived task occupies its companion, including when idle. Archiving the task releases the companion. A handoff assigns an available companion while preserving the conversation, working directory, project, and task summary. Resuming an archived task requires an available companion, checked again by the server.

Task renaming and Muse-authored descriptions use the same `session_summary` field. They do not rename the companion. Companion definitions are read-only in the UI.

For local setup and testing, see [LOCAL_DEVELOPMENT.md](../docs/LOCAL_DEVELOPMENT.md).
