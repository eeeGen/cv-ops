# CV-ops

CV-ops 是一个本地、可追溯的 Codex 简历与职位描述工作流插件。候选人档案、简历、JD、截图和运行记录必须保留在由用户明确指定、且位于插件仓库外的私有工作区。

它不自动投递职位，也不承诺求职结果、PDF 导出或 ATS 一定通过。事实冲突、未确认陈述、输入失败或依赖缺失都必须保持为 `blocked`，不能猜测或伪报成功。

## 功能范围与运行条件

CV-ops 已支持：HTML 原件归档、可提取文本 PDF 的语义 HTML 转换（扫描版或无法审计提取的 PDF 会明确 `blocked`）、文本/文件/URL/JSON/CSV/XLSX 与批量 JD 导入、固定规则的关键词/资格与语言 Gate/五维 Fit 评分/稳定排序，以及在用户明确选择合格 JD 且事实门禁通过后生成独立定制 HTML 与 `changes.md`。原始简历不会被改写。

ATS 流程已实现真实 Playwright/Chromium 渲染和登记 verifier 门禁。只有渲染和 verifier 都实际完成时，结果才可能为通过；本机缺少浏览器依赖、渲染失败或 verifier 失败时必须为 `blocked` 或 `not_executed`。

## 安装

在 Codex 插件管理界面先选择“添加 marketplace/插件市场”，并使用本公开仓库地址；再在该 marketplace 中安装 `cv-ops`。marketplace 清单位于 `.agents/plugins/marketplace.json`，插件清单位于 `.codex-plugin/plugin.json`；安装后应显示为 `CV-ops`。

本地检查：

```powershell
git clone https://github.com/eeeGen/cv-ops.git CV-ops
Set-Location CV-ops
npm install
npm run build
npm run doctor -- --workspace "E:\candidate-workspace"
```

需要 Node.js 22 或更高版本。公开发布包的 `npm run build` 只执行运行时代码静态检查；完整测试、规划和发布审计保留在私有开发仓库。

## 初始化私有工作区

先选择一个由用户拥有、位于插件仓库外的空目录。仅当目录不存在时，才在 PowerShell 中创建它：

```powershell
$workspace = "E:\candidate-workspace"
if (-not (Test-Path -LiteralPath $workspace)) {
  New-Item -ItemType Directory -Path $workspace -ErrorAction Stop | Out-Null
}
```

随后从插件仓库根目录运行初始化器：

```powershell
npm run init-workspace -- --workspace $workspace
```

初始化器成功时退出码为 `0` 并输出 `ready` JSON；拒绝时退出码为 `1`，输出包含 `reason` 和 `nextAction` 的 `blocked` JSON。不要在非空目录、插件目录或符号链接重定向路径中初始化。

## ATS 门禁

只有真实 Playwright/Chromium 渲染已成功运行、且登记的 verifier 已执行后，ATS 才可能报告通过。缺少 Playwright/Chromium、渲染失败或 verifier 失败时必须是 `blocked` 或 `not_executed`，绝不等同于 ATS 通过。

## 隐私、许可证与上游

不要向公开仓库提交候选人材料、私有工作区、浏览器产物、运行记录、访问令牌或密钥。固定上游版本、文件哈希和许可证归属见 [UPSTREAMS.md](UPSTREAMS.md) 与 [NOTICE](NOTICE)。CV-ops 以 [MIT License](LICENSE) 发布。
