# Claude Code

<!-- pulse:start (managed by vitalos-op pulse/kit/install.sh; edit there) -->
## Pulse: every session reports here

This repository reports to Vitalos Pulse through `.pulse/`. Every session and agent follows `.pulse/README.md`:

- **Start** with `.pulse/bin/pulse start "<one line: what you are doing>"`. It creates your session file in `.pulse/sessions/`.
- **Keep it current** after each major step, when blocked and before you stop (`pulse log`, `next`, `need`, `blocker`, `status`, `done`). Commit it with your work and push your branch at least once per work block, even unfinished.
- **Update `.pulse/STATUS.md`** when the project's stage, health, next steps, needs or blockers change.
- **Never put secret values in `.pulse/`**; name the variable instead.
- **This repository is public.** Nothing in `.pulse/` may hold security findings, internal hosts or IP addresses, email addresses, customer names, spend or unannounced plans; put those in a Pulse note (`create_note`) instead.
<!-- pulse:end -->
