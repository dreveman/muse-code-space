# Publishing Muse Code Space changes

`AGENTS.md` and the **current web-artifact builder instructions/artifacts
skill** are authoritative. The builder interface, not a repo script or a
sentinel file, owns the exact **plan → build → audit → submit** flow. A source
checkout cannot claim that its changes have been deployed.

1. Edit and verify source; run `bun run typecheck`, the client/server and
   pilot tests, and `bun run test:restart` where available.
2. Have the builder list the artifact (slug is in the generated `space.json`;
   see `docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md`) and edit that slug. For a
   brand-new installation, follow the guide's create → generate `space.json`
   → edit flow. Do not hand-edit `.space-build/`.
3. Have the builder apply/audit Drizzle migrations while **preserving** its
   managed `app.db`, then submit. Check that the app's actions and data still
   work after deployment. Do not use `bun run build` as a publishing step.
4. Install changed pilot source **separately** through `pilot/install.sh`
   (see `docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md` and `docs/PILOT.md`). Never
   overwrite pilot registry/transcripts or the live runtime files by hand.

Do not write `.publish-request`: that old local sentinel workflow is not the
web-artifact builder and does not prove a successful audit/submit. Only report
"Published" after the builder actually confirms success. Do not push a
public GitHub repository without the user's approval and a credential/runtime
state audit.
