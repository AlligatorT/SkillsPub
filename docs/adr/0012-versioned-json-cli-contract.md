# ADR-0012: Versioned non-interactive JSON contract

状态: accepted (2026-08-22)

SkillsPub 把全部非 TUI 命令作为一个公共自动化接口：JSON 模式统一返回带 `schemaVersion: 1` 的 `{ ok, data }` 或 `{ ok, error }` envelope，而不是让每个命令自定义顶层结构。该模式不输出 ANSI、不进入交互；mutation 没有 `--yes` 时安全地返回 `applied: false` 与完整 plan，带 `--yes` 才执行。

退出码只区分命令完成（0）、领域/预检/运行失败（1）与 usage 错误（2）。Drift、update available 和 warnings 是成功结果中的状态，不借用非零退出码；若未来需要 CI gate，增加显式检查模式。这样调用方可依赖一个版本化协议，CLI 仍可分别演进各命令的 `data`，也避免交互确认破坏无人值守管道。
