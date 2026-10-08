# Muse Code Space

Your personal Muse assistant knows your interests, your projects, and why they
matter to you. Muse Code Space puts that understanding to work: your assistant
can help you develop and maintain software by supervising and coordinating Muse
Code agents running on your Muse VM. You can hand off several tasks, see which
agents are making progress or need help, and return to the work without hunting
through terminal windows or losing the thread.

Think of it as a small control room for the people and agents building software
together—not a replacement for your editor. Muse can stay in the loop while
you focus on decisions that actually need you.

## What you can do

- **Keep multiple agents in view.** See who's working, blocked, or done.
  Organize by project and set old agents aside without losing their history.
- **Hear when you're needed.** Your Muse assistant can notify you when a coding
  agent needs your personal attention to proceed. Step in for a question,
  decision, or blocker without watching every agent's output.
- **Coordinate instead of copy-pasting.** Ask Muse to direct work or message
  another agent with `@name`; agents exchange updates while you stay in charge.
- **Understand work at a glance.** Follow live transcripts, tool calls,
  searches, and diffs. Summaries and animal avatars help you recognize agents;
  raw output remains available when you need to investigate.
- **Stay close to the code.** Open an agent's terminal and written files beside
  the conversation. Inspect, copy, or download a file without interrupting it.
- **Pick up where you left off.** Continue conversations after a break or
  restart; each agent keeps its workspace, transcript, model and effort.
- **Work from desktop or phone.** Resizable panes fit a transcript and terminal
  side by side on desktop; smaller screens keep each view focused.

## Install with your Muse assistant

Give your Muse assistant this prompt:

> Install the Code Space web app (a sidebar for supervising Muse Code agents)
> and its pilot backend on this VM: clone
> `https://github.com/dreveman/muse-code-space.git` into
> `~/workspace/github/dreveman/muse-code-space`, then follow
> `docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md` for installation and operation.

For a reinstall from an existing checkout (source already at
`~/workspace/github/dreveman/muse-code-space`):

> Reinstall the Code Space web app and its pilot backend on this VM from the
> existing checkout at `~/workspace/github/dreveman/muse-code-space`, following
> `docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md`. Do not delete and recreate the
> artifact; update it in place.

The guide covers setup, safe updates, and day-to-day operation.

## More information

- [Muse assistant install guide](docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md)
- [Local development](docs/LOCAL_DEVELOPMENT.md)
- [Pilot and restart recovery](docs/PILOT.md)
- [Live testing](docs/LIVE_TESTING.md)
- [Publishing changes](docs/PUBLISHING.md)
