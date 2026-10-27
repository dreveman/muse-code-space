# Install prompt for Muse Code Space

Copy the prompt below to the user's Muse assistant to start an install or
reinstall. The credentials gate is written out **in the prompt itself**, not
only in the guide, on purpose: the gate is the step whose omission produces
a finished-looking install that fails on first use, so it must reach the
installing assistant even if the guide is only skimmed — and the assistant
must never need to read installer script source to learn it.

---

Install (or update) Muse Code Space for me.

Follow `docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md` in the repository
`https://github.com/dreveman/muse-code-space.git` (checkout:
`~/workspace/github/dreveman/muse-code-space`). If anything goes wrong,
stop and tell me — do not improvise around a failed step.

**Before any install step — credentials first:**

1. **Meta Model API credential (required — gate).** I must have a custom
   Secure Vault API credential named `custom.meta-model-api` holding my
   Meta Model API key. If it is not already stored, walk me through storing
   it via the Secure Vault flow now. Never ask me to paste the key in chat.
   Then verify a surrogate can be issued for the entry — Secure Vault has
   no read-back, so issuance is the verification. **If it cannot be
   verified, stop and tell me; do not install.** Without this credential
   the install completes but every agent turn fails with an auth error.
2. **GitHub credential (optional — ask me once).** If I want Code Space
   sessions to have GitHub access, walk me through storing a fine-grained
   GitHub PAT (Contents + Pull requests read/write, selected repositories
   only) via Secure Vault as `custom.github-broker`, and verify issuance
   the same way. If I decline, proceed without it — it can be added later
   without reinstalling. If I plan to use a GitHub App instead, remind me
   to have the App ID, installation ID, and private key ready for the
   post-install setup dialog (the App key is not stored in Secure Vault).

Report which credentials verified before you start the install itself.

**During the install:** never modify anything in the git checkout — deploy
artifacts are generated at install time in the staged snapshot only. Never
read the installer script's source into the conversation; run it and work
from its output. Verify the finished install at every layer (pilot health
and session recovery, app actions resolving, web bundle current, assistant
identity including `user_name` set via `setAssistantIdentity` so the Welcome
Card greets me by name, updated `hooks/code-space-watchdog.sh` and
`hooks/code-space-watchdog-state.py` copied to `~/hooks/scripts/`, and GitHub
setup state), not from pilot health alone. Do not push anything to GitHub.
When you are done, report what is live, what versions are pinned, and
anything left for me to decide.
