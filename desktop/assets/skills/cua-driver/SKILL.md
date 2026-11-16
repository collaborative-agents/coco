---
name: cua-driver
description: Use Cua Driver to inspect and operate native desktop applications, including reading windows, clicking controls, and typing. For website tasks, prefer the Browser skill and Playwright tools; use Cua for browser chrome or an explicitly requested desktop-control fallback.
---

# Local computer control with Cua Driver

For website content and navigation, prefer the Browser skill and Coco's
`mcp__browser__*` tools. Use this skill for native desktop apps, browser chrome,
or when the user explicitly requests Cua. If Playwright is unavailable, explain
the issue and get agreement before switching to desktop control.

Use the installed `cua-driver` CLI through Coco's bash tool. This controls the current computer; Cua Spaces, remote pairing, and RDP are not required. Coco's existing command approvals still apply. Loading this skill does not authorize unrelated desktop actions or grant macOS permissions.

## Check availability

Find `cua-driver` on PATH. GUI-launched Coco may have a different PATH from the terminal: also check `$HOME/.local/bin/cua-driver`, `/opt/homebrew/bin/cua-driver`, and `/usr/local/bin/cua-driver`. Use the discovered executable's quoted absolute path for subsequent commands. If none exists, explain that Cua Driver must be installed on this computer and point to https://cua.ai/docs/cua-driver/quickstart. Do not install software or change remote sharing settings as part of an ordinary desktop task.

Run `cua-driver status`, `cua-driver permissions status`, and `cua-driver doctor` before the first interaction in a session. Read the diagnostic output, not just the exit code. If permissions are missing, guide the user through `cua-driver permissions grant` and the macOS Accessibility and Screen Recording switches, then recheck. Do not claim that a command can grant those macOS permissions automatically.

## Use the installed tool contract

Start with `cua-driver --help` and `cua-driver call --help` to discover the installed version's tool-listing and schema commands. `cua-driver call list_apps` is a useful read-only connection check. Inspect tool schemas before constructing calls; do not guess window IDs, coordinates, or argument names.

If the upstream skill pack is installed, `cua-driver skills path` prints its location. Read its `SKILL.md` and relevant supporting references using Coco's file tools; access outside the workspace may request approval. Otherwise use the CLI's tool schemas and help. Do not assume `cua-driver skills install` has already been run.

Inspect the target app/window before acting. Prefer accessible controls and element identifiers when available. For pixel actions, use a fresh capture and the capture identifier required by the driver. Inspect screenshot files with Coco's image-capable read tool when visual reasoning is needed; store new task artifacts in the working directory where the CLI supports choosing an output path.

Use background delivery when the app supports it. If it reports that background input is unavailable, explain when foreground interaction is needed instead of promising not to disturb the user's desktop. Respect the user's chosen app and task scope. Do not attach to existing browser profiles or enable broader driver permission modes unless the task is authorized to use that access.

After an action, obtain a fresh state or screenshot and verify the result. Report an observed result rather than inferring success from a command exit code. For an initial smoke test, open Calculator, compute 6 × 7, and read back the displayed result.
