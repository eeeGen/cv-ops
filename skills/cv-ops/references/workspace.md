# 候选人工作区契约

仅在用户明确指定一个**已存在、空白且位于插件仓库外**的目录后，才能初始化候选人工作区。不得猜测默认目录，也不得在插件仓库、其子目录或解析后指向这些位置的链接中创建候选人材料。

初始化器创建以下私有布局，并在工作区根写入 `.gitignore` 的 `private/` 规则：

```text
private/
  profile.yml
  evidence/{experience-evidence.yml,star-stories.md}
  resumes/{original,normalized,tailored}/
  jobs/{inbox,normalized}/
  reports/{match,changes,ats}/
  runs/
```

调用 `initializeWorkspace({ workspacePath, pluginRoot })` 前，应先向用户确认路径。结果始终是结构化的 `ready` 或 `blocked`；出现 `blocked` 时，向用户说明其 `reason` 和 `nextAction`，不要尝试在其他路径重试。

每次处理使用 `createRunRecord({ workspacePath, pluginRoot, run })` 在 `private/runs/<runId>/run-record.json` 创建不可覆盖的运行记录。记录仅包含 `runId`、时间、输入来源标识与 SHA-256、固定上游版本、位于 `private/` 下的相对产物路径，以及 `complete` 或 `blocked` 状态（后者含结构化原因）。不得在运行记录中复制简历、JD、事实文本、令牌或其他候选人内容。
