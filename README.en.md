# dsh-remote

[简体中文](README.md) | **English**

Drive **DeepSeek Harness (dsh)** from any browser: let dsh work on your desktop, keep directing it from your phone on the road, and pick up the same session on your laptop at home.

- **Bundles dsh**: installing dsh-remote is all you need — **no separate dsh installation**. dsh ships as a dependency; upgrading dsh-remote upgrades dsh
- **No dsh forks or patches** — always tracks the official release
- Controlled machines **listen on no public port**; they dial out, so your router needs no port forwarding
- The UI is dsh's own (all 40 official UI plugins work unchanged)
- Every non-loopback browser visit **requires login** (password + TOTP)

## How it connects

Every machine running dsh-remote is **identical**: its own dsh, a console, and a dialer. The only difference is **which one you treat as the entry machine** — the one your browser actually opens.

> **Each machine runs its own dsh; file access and command execution happen locally on that machine.**
> Opening pc2's page directs pc2's dsh working on pc2's code; pc1 only forwards. "Attaching pc2 to pc1" means pc2's dsh becomes reachable at pc1's address from then on — not the other way around. **Choosing a machine = choosing where your code runs.**

```
                    ┌──────────────────────────────────────┐
   phone /          │  pc1 (entry machine, e.g. a VPS      │
   tablet    ───>   │  or an always-on home computer)      │
   browser          │                                      │
                    │   console  ←── login, routing, list  │
                    │      ↑  ↑                            │
                    │      │  └──> pc1's own dsh           │
                    └──────┼───────────────────────────────┘
                           │
              reverse tunnel (dialed out by the exposed machine,
                           no public IP needed)
                           │
              ┌────────────┴────────────┐
              │                         │
      ┌───────┴────────┐       ┌────────┴───────┐
      │  pc2            │       │  pc3           │
      │  dialer ──> dsh │       │  dialer ──> dsh│
      └────────────────┘       └────────────────┘
      office desktop                 home laptop
```

- The relation is **one-way**: pc1 can open pc2, but pc2 cannot open pc1; any machine can act as the entry
- Exposed machines **need no public IP and no port forwarding**
- Each attached machine gets a **fixed port** on the entry machine (e.g. `http://pc1:30810` is pc2) — safe to bookmark; once the entry machine sets `relay.domain` behind a TLS proxy, subdomains like `https://pc2.your-domain` take over instead (recommended for the public internet — see the [deployment guide](deploy/README.md))
- dsh only ever listens on `127.0.0.1`; every outward-facing door is guarded by the console

## Requirements

| | Requirement |
|---|---|
| OS | Windows / Linux / macOS |
| Node.js | **22.19+** (LTS from [nodejs.org](https://nodejs.org); check with `node -v`) |
| Network | Exposed machines must reach the entry machine; the entry machine must be reachable if it is on the public internet |
| dsh | **Not needed** — bundled in the package |

## Install

Download the zip for **your platform** from [Releases](../../releases) and unpack (dsh is included). Each platform comes in **core / full** variants — pick what you need:

| Feature | core | full |
|---|---|---|
| dsh core features | ✅ | ✅ |
| Office document preview | ❌ | ✅ |

- **Windows**: double-click `dsh-remote.exe`. The exe is unsigned; if SmartScreen complains, choose "More info → Run anyway". Or run `pwsh -File .\start.ps1`
- **Linux / macOS**: `./start.sh`

> Packages are per-platform because dsh's dependencies ship prebuilt platform binaries; dsh-remote's own code has zero native modules.

Or build the exact same package from source:

```bash
git clone <this-repo-url> dsh-remote
cd dsh-remote
pnpm install
pnpm release
```

`pnpm release` builds first (skip with `--skip-build`), targets the host platform by default (`--target=all` for all), packs both core and full variants per platform (filter with `--variant=core`), and writes the zips to `release/` — unpack and start it as above. Packing requires pnpm >=10 (the project does not force a local pnpm version; CI pins 10.17.0 for reproducibility). The Windows `dsh-remote.exe` is compiled with [Go](https://go.dev/dl/); without Go, add `--skip-exe` and that package starts via `start.ps1` only.

## First start

Unpack and start on the machine you want as the **entry machine** (double-click `dsh-remote.exe` on Windows, run `./start.sh` on Linux / macOS). The first start has no admin account yet, and the program hands you the setup address:

- **Windows**: the tray pops up a "setup not finished" notification — clicking it opens the setup page; started via `start.ps1`, the terminal prints the same address
- **Linux / macOS**: the `./start.sh` terminal prints an address like `http://127.0.0.1:30809`

Open it **on that machine** in a browser:

1. Pick the account name (pre-filled `admin`; letters, digits and `. _ -`) and set the admin password (at least 6 characters, mixing at least 3 of: upper case, lower case, digits, symbols)
2. Scan the QR code with an authenticator app (Microsoft / Google Authenticator, 1Password, …)
3. Enter the 6-digit code to confirm

From then on, access from your phone or any other computer uses **that account name** plus the password and the TOTP code (the console's "Account" page shows the name if you forget it).

> 🔒 The setup wizard is **loopback-only** (`127.0.0.1`); anyone else on the LAN only sees "finish setup on that machine" and cannot hijack the admin account. On a headless server the wizard is out of reach — see "Emergency" below.

Restart once and every access address is printed — in the terminal if you started it there, otherwise in the log shown by the tray menu's "View log":

```
  ✓ Node v22.19.0
  ✓ dsh ready            127.0.0.1:3080
  ✓ pc1 console running  0.0.0.0:30809
  ○ no remote entry      pc1 reachable from localhost and LAN only

  ┌────────────────────────────────────────────────────┐
  │  local console  http://127.0.0.1:30809   no login  │
  │  LAN access     http://10.1.2.87:30809   login     │
  └────────────────────────────────────────────────────┘
```

On the machine itself, `http://127.0.0.1:30809` is **login-free** (loopback only). dsh's own address is never advertised — always go through the console, which handles the token exchange dsh has required since 0.1.2. Exit via the tray menu's "Quit" or `Ctrl+C` in the terminal; all three processes shut down together.

## Attaching a second machine

1. Start dsh-remote on **pc2** too; it will say "no remote entry" — expected, leave it running
2. On **pc1**, open `http://127.0.0.1:30809/_admin`, enter pc2's machine name under "expose another machine via pc1", and issue a token. The page shows a copy-paste command:
   ```
   dsh-remote-connector --relay ws://192.168.1.10:30809 --slug pc2 --enroll-token xxxxx --hub-authority 192.168.1.10
   ```
3. On **pc2**, open the console → "Remote entry" page (`http://127.0.0.1:30809/_admin/hub`) and paste the whole command into the only input box

pc2 **connects immediately, no restart**, and gets a fixed port on pc1; from pc1's address plus that port you are now driving **dsh on pc2**.

> The token is single-use and valid for **5 minutes**: it is deleted from the database once pc2 registers its device public key and is never shown again — just issue a new one if it expires.
>
> ⚠️ pc2's dsh must trust pc1's address: after pasting, **restart dsh-remote on pc2 once** and the launcher adds it automatically.

## Day-to-day

Everything happens in the browser. The console at `/_admin` has three tabs; each page is headed "you are managing pc1", since consoles on different machines look identical:

| Tab | Path | What it manages |
|---|---|---|
| Machines | `/_admin` | machines exposed via this one; enrollment tokens |
| Remote entry | `/_admin/hub` | which machine this one is attached to; set / cancel |
| Account | `/_admin/account` | change password, reset authenticator |

| To do this | Go here |
|---|---|
| See which machines you can open | "Machines" |
| Expose one more machine | "Machines" → "expose another machine via …" |
| Detach and disable a machine | "Machines" → "stop … and remove" — **dsh-remote on that machine exits entirely**, its tokens are revoked |
| Set / cancel this machine's remote entry | "Remote entry" |
| Change password / new phone for authenticator | "Account" |
| See what happened recently | There is no such page in the UI — see "Security" below |

### Emergency: if the web UI is unreachable

Only for two situations: **first deployment on a headless server**, or **both password and authenticator lost**.

```bash
node dist/relay.js init          # create the admin (first server deployment)
node dist/relay.js passwd        # reset the admin password
node dist/relay.js totp reset    # reset the authenticator, re-scan
```

> Run these inside the **unpacked package directory**; when working in the source repo the equivalents are `pnpm relay:init` / `pnpm relay:passwd` / `pnpm relay:totp-reset`.
>
> These commands **do not ask for the old password** — anyone who can run commands on that machine can already read the database file directly. What you must guard is login to the machine itself. On a VPS the setup wizard is loopback-only and unreachable from your local browser — create the admin with `init`, or borrow the wizard over SSH port forwarding (below).

For the first deployment you can skip `init`: open an SSH tunnel from your own computer —

```bash
ssh -L 30809:127.0.0.1:30809 user@server
```

While the tunnel is up, open `http://127.0.0.1:30809` in your local browser. The request lands on the server's loopback interface, so the wizard admits it and you can scan the QR code as usual. Always open that exact `127.0.0.1:30809` address — the Host header must stay loopback to remain login-free. The wizard is a one-time thing: disconnect the tunnel once setup is done and use the server's public address day to day.

## Security

This tool hands your dev machine to a browser. Read this once:

- **Never expose it to the public internet without HTTPS.** Plain HTTP on the LAN is an accepted trade-off (a loud warning is printed at startup); on the public internet you must put HTTPS in front (Caddy or similar with automatic certificates).
- dsh itself has no authentication and only listens on `127.0.0.1`; the console is the only door — **a compromised console account equals a compromised machine** (whoever can start a session can run commands).
- Five failed logins lock the account for 15 minutes.
- **The default is fixed YOLO mode**: `dsh-remote-web` hides the permission selector, `bash` / `pwsh` / `write` / `edit` run with the dsh process user's permissions, and legitimate approval requests are allowed automatically. Disable the `yolo-mode` plugin and restart dsh to restore dsh's native permission protection. `ask_user_question` still asks you questions.
- **Security records are not in the web UI**: login attempts, machine attach/remove, password/authenticator changes are written to both the relay log (JSON lines with `"audit":true`) and the `audit_log` table in `relay.db`, never auto-expiring; inspect them on the machine running the relay.
- Threat model and accepted trade-offs: [docs/04-security.md](docs/04-security.md) (Chinese).

## Troubleshooting

| Symptom | Cause |
|---|---|
| Node version too low | Install 22.19+ |
| Works locally, not from the LAN | Firewall. Windows: `New-NetFirewallRule -DisplayName "dsh-remote" -Direction Inbound -LocalPort 30809 -Protocol TCP -Action Allow` |
| Correct password rejected | Check the startup log for a "pre-scrypt password hash" warning; if present, reset the password once on the local admin page |
| 403 on an attached machine's page | Its dsh doesn't trust the entry machine's address yet — restart dsh-remote on that machine |

## Local development and debugging (for developers)

`pnpm dev` / `pnpm start` in the repo are a **dev/debug stack**, not an installation: they run the repo's source or built artifacts, keep the relay database and device key in the repo's `.dev/` directory, and use the fixed machine name `pc1` — fully separate from a real install's `~/.dsh-remote`, so don't use it as your daily instance.

```bash
pnpm dev       # run the TypeScript source directly via tsx
pnpm start     # run the dist artifacts produced by pnpm build
```

Development conventions and the usual checks (lint / typecheck / build / test) live in [AGENTS.md](AGENTS.md) (Chinese).

## Docs (for developers, in Chinese)

| Doc | Contents |
|---|---|
| [AGENTS.md](AGENTS.md) | conventions and hard rules for AI assistants |
| [docs/README.md](docs/README.md) | documentation navigation and maintenance rules |
| [docs/plugins.md](docs/plugins.md) | plugin features, entry points, and package READMEs |
| [docs/01-decisions.md](docs/01-decisions.md) | current decisions, terminology, and product boundaries |
| [docs/02-dsh-facts.md](docs/02-dsh-facts.md) | verified dsh source facts (each with file paths) |
| [docs/03-architecture.md](docs/03-architecture.md) | components, tunnel protocol, request flow |
| [docs/04-security.md](docs/04-security.md) | auth design, threat model, accepted risks |
| [docs/05-roadmap.md](docs/05-roadmap.md) | milestones and acceptance criteria |
| [docs/06-packaging.md](docs/06-packaging.md) | portable package layout, launcher, dependencies |

## Status

The tunnel, authentication, portable packages, and 21 bundled plugins are implemented. Outstanding device checks and next steps are tracked in [docs/05-roadmap.md](docs/05-roadmap.md) (Chinese).

| Item | Value |
|---|---|
| dsh version | `0.1.5-rc.2` (developer preview, **breaking changes expected**) |
| dsh Node requirement | `^22.19.0 \|\| >=24.0.0` |
| Runtime policy | uses your local Node; no Node binary bundled |
| Native modules | zero in our own code (scrypt from Node core); dsh ships prebuilt per-platform binaries, hence per-platform packages |

## License

[MIT](LICENSE) © dsh-remote contributors
