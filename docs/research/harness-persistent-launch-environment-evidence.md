# Research: Can persistent launch environments cover every Harness entry point?

**Research date: 2026-09-03. Ticket: [#113](https://github.com/AlligatorT/SkillsPub/issues/113), part of [Wayfinder map #102](https://github.com/AlligatorT/SkillsPub/issues/102).**

This note uses operating-system specifications, official product documentation, and pinned first-party source. It distinguishes a persisted setting from the environment of a concrete process and does not treat path presence, marketing claims, or an unverified launcher as Effective Visibility evidence.

## Conclusion

**No. Persistent environment provisioning cannot cover every relevant Harness entry point unless SkillsPub owns, wraps, or has a verified integration with every launch boundary.**

An environment is process state. POSIX `exec` either uses the caller's `environ` or an explicit `envp`; Windows gives each process an environment block, lets a child inherit its parent's block by default, and lets `CreateProcess` supply a different block. Microsoft is explicit that one process can directly alter another process's environment only while creating its child. Persisting a value changes what some future launchers may read; it neither controls every launcher nor rewrites already-running processes. [POSIX.1-2024 `exec`](https://pubs.opengroup.org/onlinepubs/9799919799.2024edition/functions/exec.html) · [Microsoft: Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables) · [Microsoft: Changing Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables) · [Microsoft: `CreateProcessA`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa)

Three properties must therefore remain separate:

1. **Persistence** — a file, registry value, manager store, or launch profile survives for a later launch.
2. **Coverage** — the actual launcher consults or inherits that source and does not replace, remove, or sanitize it.
3. **Current process state** — the concrete Harness/backend process actually has the value or command-line argument now.

None proves either of the others.

For SkillsPub, the narrowest defensible Effective Visibility scope is:

> one named, newly created Harness process or backend, reached through one versioned and controlled entry point on one OS/user/session, whose actual environment or argument vector and new-load Skill result are verified.

A persistent store alone is not sufficient evidence. Uncontrolled entry points remain `unknown`; already-running processes remain outside the claim.

## Harness implications from #103–#107

The published candidate investigations reach the same boundary from product-specific evidence:

- **Codex — `discoverable`:** deterministic roots and path-addressed enable/disable exist, but required Shared roots, user/session overrides, external/session roots, canonical link identity, and unowned recovery prevent universal control. [#103 note and pinned commit](https://github.com/AlligatorT/SkillsPub/blob/8043c5a9c2d5da235a624b0825789407b8574ad5/docs/research/harness-codex-v01-evidence.md)
- **OpenCode 1.18.8 — `discoverable`:** `OPENCODE_DISABLE_EXTERNAL_SKILLS` is a real environment variable read from the OpenCode process and suppresses `.agents/skills` plus `.claude/skills`; it does not suppress native roots or configured `skills.paths`/`skills.urls`. No persistent schema field replaces it. Because SkillsPub does not launch every TUI, `run`, `serve`/`web`, ACP/IDE, desktop-sidecar, or attached-client backend, it cannot prove the flag is present in the process that performs discovery. [runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/effect/runtime-flags.ts) · [pinned discovery](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/skill/index.ts) · [#104 note](https://github.com/AlligatorT/SkillsPub/blob/3c43bde3439ac0d4a7e25158779a052e965899b3/docs/research/harness-opencode-v01-evidence.md)
- **Kimi Code — `discoverable`:** `--skills-dir` is not an environment variable. Official docs say the repeatable flag **replaces** automatic user/project roots **for that launch only**; persistent `extra_skill_dirs` is additive. Kimi also exposes interactive, print, `acp` (IDE-launched subprocess), and foreground `web` entry points. Persistent OS environment provisioning cannot inject an argument into all of them; doing so requires ownership of each command/profile/integration. [Kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html) · [Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html) · [pinned scanner](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/skill/scanner.ts) · [#105 note](https://github.com/AlligatorT/SkillsPub/blob/eeae7a3652a6c93549e80ed9a03d6031f49019c6/docs/research/harness-kimi-code-v01-evidence.md)
- **WorkBuddy — `unsupported`:** no official filesystem Target, consumed-root, machine-readable isolation, next-load, or recovery contract was established. An environment strategy cannot fill a missing Harness contract. [#106 note](https://github.com/AlligatorT/SkillsPub/blob/4ec5dbfa477526060766cbd8459d96abdb5be8e6/docs/research/harness-workbuddy-v01-evidence.md)
- **TraeCode — `discoverable`:** official UI behavior establishes some roots and toggles, but the persistent schema, complete precedence, reload boundary, regional parity, and recovery remain unverified. No official environment control was established. [#107 note](https://github.com/AlligatorT/SkillsPub/blob/c6ef801cce8aa37d84539dc59179e561bc3bf158/docs/research/harness-trae-v01-evidence.md)

Persistent environment provisioning therefore does not promote any of these findings to `managed`.

## Entry-point coverage

| Entry point | Mechanism that can cover a specific instance | Why it is not universal without launch ownership/integration |
| --- | --- | --- |
| Interactive login shell | That shell's login files; PAM/login environment | Shell- and mode-specific; files can be suppressed; different shells read different files |
| Interactive non-login shell | That shell's rc file or parent environment | Different startup path; `--norc`, `-f`, `NO_RCS`, or an explicit environment bypasses it |
| Non-interactive shell/script | Parent environment; shell-specific non-interactive hook such as Bash `BASH_ENV`; wrapper | Often reads different/no startup files; caller can replace the environment |
| Terminal CLI | Export in the actual shell, terminal profile environment, or wrapper | Covers only that terminal/profile/process tree; direct binary execution or another profile bypasses it |
| macOS Finder/Dock/desktop GUI | Correct launchd context where supported; per-app launch configuration | Shell files are not Launch Services configuration; manager domain, ordering, app-specific, and stale-process limits remain |
| Linux desktop GUI | PAM/session environment, user-manager environment, or a specific desktop entry | Desktop/session implementation varies; D-Bus activation may ignore a desktop entry's `Exec`; session may already be running |
| Windows desktop GUI | User/machine registry values plus a cooperative fresh launcher | Existing/stale launchers retain their block; notification is not mutation; launcher may pass a custom block |
| IDE terminal/task/debug/extension | IDE-specific environment/profile/settings plus a fresh backend | Subsystems can override each other; singleton, local/remote, web, extension-host, and language-server processes have distinct boundaries |
| macOS launchd job | That job's plist or the correct launchd domain | Per-job/domain only; requires permissions and restart/new launch |
| Linux systemd service | User/system manager or unit configuration and service restart | User and system managers differ; unit settings can override manager values |
| Windows service/task | Service/task account and launcher configuration, then restart | Separate account/security context and long-lived Service Control Manager/Task Scheduler parent |
| SSH remote | Remote provisioning or negotiated `SendEnv`/`SetEnv` plus server `AcceptEnv` | Server policy controls acceptance; local persistence does not configure the remote host |
| Container/WSL/Codespace/CI | Image/runtime/dev-container/platform configuration | Separate namespace and lifecycle; variables must cross an explicit bridge |
| Already-running process | Application-specific live reconfiguration, if one exists, or restart | No generic retroactive environment mutation exists |

## Shell startup files

Shell files are useful but bounded:

- Bash login shells, interactive non-login shells, and non-interactive shells use different startup paths; `--noprofile` and `--norc` suppress relevant files, and a non-interactive shell uses `BASH_ENV` only under the documented conditions. [GNU Bash §6.2](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html)
- Zsh reads `.zshenv`, `.zprofile`, `.zshrc`, and `.zlogin` according to shell mode; `-f`/`NO_RCS` can suppress user startup files. [Zsh §5.1](https://zsh.sourceforge.io/Doc/Release/Files.html#Startup_002fShutdown-Files)
- PowerShell has multiple host/user profile paths, and `pwsh -NoProfile` skips profiles. [PowerShell `about_Profiles`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_profiles) · [`about_Pwsh`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh)

Editing one startup file cannot cover direct executable launches, GUI applications, services, remote backends, containers, or shell modes that do not read it.

## macOS

macOS exposes several separate mechanisms, not one universal user environment:

- Apple Terminal documents inheritance only for commands executed in that shell's context. [Apple Terminal: Use environment variables](https://support.apple.com/guide/terminal/use-environment-variables-apd382cc5fa-4f58-4449-b20a-41c53c006f8f/mac)
- The macOS 15.1 shipped `launchctl(1)` man page says `setenv` applies to **future processes launched by launchd in the caller's context**; `unsetenv` has the same future/context boundary. It also says persistent `launchctl config system|user` supports only `umask` and `PATH`, and “cannot be used to set general environment variables … for security reasons”; a service-specific `PATH` wins. This is primary local OS documentation, not a promise of a durable arbitrary-variable store.
- `launchd.plist` `EnvironmentVariables` sets variables before running **that job**. It is appropriate for one owned daemon/agent, not unrelated applications or other launchd domains. [Apple OSS `launchd.plist(5)`](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5) · [Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- Finder and other GUI launch paths use Launch Services rather than shell startup processing. Apple's archived `LSEnvironment` key is per application bundle and applies to Launch Services launches, so even that mechanism is app-specific and direct executable launches differ. [Launch Services overview](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/LaunchServicesConcepts/LSCIntro/LSCIntro.html) · [`LSEnvironment`](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html#//apple_ref/doc/uid/20001431-102088)

A login LaunchAgent that runs `launchctl setenv` would still be limited to its launchd context, only future descendants, and ordering relative to other login items. No retained current Apple source establishes a persistent, race-free, arbitrary-variable API covering every Finder/Dock/Spotlight/direct/daemon/SSH launch. That absence must remain an evidence gap, not be replaced with an inference.

## Linux

Linux has multiple login, desktop, user-service, and system-service authorities:

- `environment.d` defines variables passed to services started by the **systemd user instance**. Its Applicability section says shells not launched by that manager inherit from whatever started them; SSH and graphical sessions have their own environment assembly. It does not configure the system service manager. [systemd `environment.d` source](https://github.com/systemd/systemd/blob/main/man/environment.d.xml)
- system and user service managers assemble spawned-process environments differently. Unit `Environment=`, `EnvironmentFile=`, `PassEnvironment=`, and `UnsetEnvironment=` can add, override, pass, or remove values. [systemd `systemd.exec`, “Environment Variables in Spawned Processes”](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
- `systemctl import-environment` imports the caller's values into a manager environment block; importing the whole shell block is deprecated because shell-local variables are confusing to unrelated processes. It does not rewrite live services. [systemd `systemctl` source](https://github.com/systemd/systemd/blob/main/man/systemctl.xml)
- `/etc/environment` or `pam_env` applies only when the relevant PAM stack includes and enables that module; Linux-PAM explicitly permits per-service configuration and can disable reading the environment file. User `.pam_environment` support is disabled by default and deprecated for security reasons. [Linux-PAM `pam_env(8)` source](https://github.com/linux-pam/linux-pam/blob/master/modules/pam_env/pam_env.8.xml)
- A desktop entry's `Exec` covers that entry; `DBusActivatable=true` allows the implementation to ignore `Exec` and activate over D-Bus. [Desktop Entry `Exec`](https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html) · [recognized keys](https://specifications.freedesktop.org/desktop-entry-spec/latest/recognized-keys.html)

Consequently neither `/etc/environment`, `environment.d`, shell rc files, nor a desktop wrapper universally covers desktop apps, cron, SSH, system daemons, user services launched elsewhere, containers, or existing sessions.

## Windows

Windows has durable user/machine values, but process inheritance still controls the result:

- User variables are stored under `HKEY_CURRENT_USER\Environment`; system variables are stored under `HKEY_LOCAL_MACHINE\System\CurrentControlSet\Control\Session Manager\Environment`. Applications should broadcast `WM_SETTINGCHANGE` with `Environment` after changing them. [Microsoft: User Environment Variables](https://learn.microsoft.com/en-us/windows/win32/shell/user-environment-variables) · [PowerShell: persistent environment variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables)
- `WM_SETTINGCHANGE` is a notification that settings changed. It does not replace the private environment block of every receiver. Child inheritance is still by default from the actual parent, and `CreateProcess` can supply a different block. [Microsoft: `WM_SETTINGCHANGE`](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange) · [Microsoft: process inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance)
- services run under their configured service account and are started by the Service Control Manager, not the interactive user's current shell tree. [Microsoft: Service User Accounts](https://learn.microsoft.com/en-us/windows/win32/services/service-user-accounts) · [`CreateServiceW`](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-createservicew)
- WSL uses the explicit `WSLENV` bridge to share selected variables across Windows and WSL, demonstrating that the environments are not one universal namespace. [Microsoft: WSLENV](https://learn.microsoft.com/en-us/windows/wsl/filesystems#share-environment-variables-between-windows-and-wsl-with-wslenv)

A registry change can support future processes created from a refreshed user environment, but cannot guarantee existing Explorer/terminal/IDE processes, other users, services, scheduled tasks, WSL distributions, or launchers that construct a custom block.

## IDE, remote, and container boundaries

- VS Code documents that its first instance inherits from its parent and later instances inherit from the already-running instance. Integrated terminals may then add/remove variables, while extension hosts can be local, web, or remote. A stale singleton or remote extension host is a different launch boundary. [VS Code terminal environment inheritance](https://code.visualstudio.com/docs/terminal/advanced#_environment-inheritance) · [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host)
- Kimi's IDE integration starts `kimi acp` as a subprocess. OpenCode also documents ACP, IDE, TUI, non-interactive `run`, standalone `serve`, and `web` entry points. Each backend's actual launcher—not the visible client—determines the environment used for discovery. [Kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html) · [OpenCode CLI](https://opencode.ai/docs/cli/) · [OpenCode ACP](https://opencode.ai/docs/acp/) · [OpenCode server](https://opencode.ai/docs/server/)
- OpenSSH sends only variables selected by client `SendEnv`/`SetEnv` and accepted by server `AcceptEnv`; `PermitUserEnvironment` is a separate server policy. [OpenSSH client](https://man.openbsd.org/ssh_config.5) · [OpenSSH server](https://man.openbsd.org/sshd_config.5)
- Dev Containers distinguish `containerEnv` from `remoteEnv`; Docker requires environment values to be passed by image/runtime configuration. The host user environment is not a universal container environment. [Dev Container specification](https://containers.dev/implementors/spec/#environment-variables) · [Dev Container JSON reference](https://containers.dev/implementors/json_reference/) · [Docker run environment](https://docs.docker.com/engine/containers/run/#environment-variables)

Remote hosts, VMs, WSL distributions, containers, Codespaces, CI runners, and orchestration platforms therefore require provisioning and verification inside their own boundary.

## Exactly what cannot be universally covered

Without SkillsPub owning launch or integrating with each authority, these entry points cannot be covered universally:

- every Harness, terminal, IDE singleton, backend, daemon, or container already running when provisioning changes;
- shells using another mode or shell, startup-suppression flags, or an explicit replacement environment;
- direct binary invocations that bypass an alias, function, shim, wrapper, terminal profile, or desktop entry;
- macOS applications launched before the launchd-context value exists, from another launchd domain, directly, or through an app-specific path not configured by SkillsPub;
- Linux D-Bus-activated applications and desktop/session processes outside the configured PAM or systemd-user path;
- Windows processes inheriting a stale parent block, using another account/session, or created with an explicit environment block;
- system daemons, services, scheduled tasks, and other-user processes SkillsPub lacks authority to configure and restart;
- IDE tasks, debuggers, extension hosts, language servers, ACP subprocesses, and remote backends whose launcher/settings are not owned and verified;
- SSH sessions where forwarding is absent or rejected, and every remote machine not separately provisioned;
- containers, WSL distributions, VMs, Codespaces, CI runners, and orchestrators not explicitly configured;
- any process that sanitizes, removes, ignores, or overrides the variable;
- every Kimi launch that does not receive `--skills-dir`, because no persistent environment value is equivalent to that argument.

Wrappers and launch profiles are not exceptions: they are scoped launch ownership. They work for calls routed through them and are bypassed by all other entry points.

## Security, backup, recovery, and uninstall limits

### Security

- Environment variables are unsuitable for secrets. systemd notes that unit environment is exposed over D-Bus and propagated down the process tree, potentially across security boundaries; it recommends credentials instead. [systemd `Environment=` warning](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml) · [systemd credentials](https://systemd.io/CREDENTIALS/)
- Shell/profile edits execute code in future shells. Values must be encoded as data, never interpolated as untrusted shell syntax. PATH-like or loader variables have especially broad command-resolution/injection impact.
- User-level setup must not silently escalate to system launchd/systemd/SCM configuration or alter other accounts. Those scopes require explicit consent and separate authority.

### Backup, recovery, and uninstall

There is no transaction spanning shell files, launchd plists/domains, PAM/session configuration, systemd managers/units, the Windows registry, IDE profiles, remote machines, and containers. A future setup would need to:

1. declare each exact owned entry point and scope;
2. record prior value-or-absence, content hash, permissions/ACLs, and ownership metadata;
3. preserve unrelated user configuration and reject concurrent changes;
4. validate syntax before activation and verify semantics after activation;
5. remove or restore only the claim still provably owned by SkillsPub.

Restoring a file or registry value restores only the persistent source. It cannot undo a value already inherited by a live process. Recovery may require a new shell, IDE/backend restart, logout/login, service restart, container rebuild, or reboot. Cross-entry-point atomic rollback is impossible.

## Next-load verification limits

`launchctl getenv`, `systemctl --user show-environment`, a shell `echo`, or a Windows registry read verifies only that store/process context. It does not prove the Harness backend inherited the value or honored it.

A valid verification must create a fresh probe through **each claimed entry point** and confirm both:

1. the actual Harness/backend process received the expected environment or argument; and
2. a uniquely named Skill canary is visible or hidden at the Harness's documented new-load boundary.

Tests must be separated for login/non-login/non-interactive shells, terminal profiles, desktop GUI launch, IDE terminal/task/debug/ACP paths, user/system services, SSH with and without a PTY, and rebuilt/reopened containers. A successful probe is evidence only for the exact OS/version, Harness version, launcher, account/session, and lifecycle tested. Existing processes must be reported as pending restart, never verified.

There is no universal outside-process oracle. Linux `/proc/<pid>/environ` is access-controlled and represents the process's initial environment rather than a guaranteed live application state; other platforms also restrict cross-process inspection. The Harness can still ignore a present flag. The authoritative proof is therefore an in-process or Harness-observed canary through the concrete entry point. [Linux `proc_pid_environ(5)`](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html) · [Microsoft: Changing Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables)

## Decision and remaining gaps

Ticket #113's universal-coverage question is resolved negatively:

- Do **not** claim that persistent environment provisioning provides universal Harness control.
- Keep OpenCode and Kimi Code at `discoverable` under the current no-launcher boundary.
- For environment-gated controls, return `unknown` whenever the actual new Harness/backend process's launch environment cannot be established.
- Treat `--skills-dir` as a launch argument, not environment provisioning.
- Reopen the product boundary only in [#114](https://github.com/AlligatorT/SkillsPub/issues/114); this ticket does not decide whether SkillsPub should own launch profiles.

The negative conclusion does not require an exhaustive real-machine matrix because one documented bypass disproves universal coverage, and every OS exposes several. The following narrower evidence gaps remain for any future opt-in launcher design:

- current macOS does not publish one complete environment-assembly contract for every Finder/Dock/Spotlight/Launch Services path;
- Linux graphical-session import behavior varies by desktop environment and distribution beyond freedesktop/systemd contracts;
- Microsoft documents notification but not a guarantee that every long-lived Windows launcher rebuilds its environment after `WM_SETTINGCHANGE`;
- no cross-platform real-machine matrix has verified every concrete OpenCode/Kimi CLI, desktop, IDE, service, and remote entry point;
- upstream versions and integration launchers may change, so every supported scope needs pinned fixtures and a new-load canary.

These gaps limit future scoped claims; they do not rescue a universal claim.
