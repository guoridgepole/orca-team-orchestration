# orca-team-orchestration 用户手册

本手册面向第一次使用 `orca-team-orchestration` 的需求方、项目协调者和开发人员，说明如何接入项目、编写需求、查看进度以及执行阶段校验。

> 适用版本：`0.0.0`  
> 文档日期：2026-10-25  
> 运行要求：Node.js 20 或更高版本、Git、Orca  
> 当前状态：基础 CLI、需求管理、运行快照、状态查看、阶段校验、守则校验、角色提示词网页编辑（含每个角色的 Agent 绑定与 Agent 池管理）与提示词渲染已可用；核心编排闭环（`start` 自动派发 Orca worker、阶段推进、失败回路、gate、检查点提交、`resume` 续跑、`accept` 验收）、`explain` 状态解释、pre-commit hook 与 `guard allow` 审批已接入，`check` 也支持角色命令检查。多仓 workspace（父目录 + 嵌套独立 Git 仓库）已支持 `init --workspace`、多仓 scope/守则/检查点/审批与逐仓 hook。完整配置页面（守则表单等）与真实 Orca 端到端联调仍在建设中。

架构与实现细节见 [DESIGN.md](DESIGN.md)；参与源码开发、运行测试与提交前检查见 [第 16 节](#16-本地开发与贡献)。

## 目录

- [1. 先了解它解决什么问题](#1-先了解它解决什么问题)
- [2. 安装](#2-安装)
- [2.1 启动本地页面](#21-启动本地页面)
- [3. 五分钟快速开始](#3-五分钟快速开始)
- [3.8 多仓 workspace（前后端独立仓库）](#38-多仓-workspace前后端独立仓库)
- [4. 编写 Story](#4-编写-story)
- [5. 日常操作流程](#5-日常操作流程)
- [6. 阶段校验](#6-阶段校验)
- [7. 守则校验](#7-守则校验)
- [8. 配置说明](#8-配置说明)
- [9. 环境自检](#9-环境自检)
- [10. 命令速查](#10-命令速查)
- [11. 退出码与结果判断](#11-退出码与结果判断)
- [12. 目录与数据](#12-目录与数据)
- [13. 常见问题](#13-常见问题)
- [14. 安全与协作建议](#14-安全与协作建议)
- [15. 后续版本说明](#15-后续版本说明)
- [16. 本地开发与贡献](#16-本地开发与贡献)

## 1. 先了解它解决什么问题

`orca-team-orchestration` 把一条需求组织成一套可追踪的开发流程：

```text
需求文件 → 运行快照 → 设计 → 审核 → 开发 → 测试 → 人工验收
              │
              └─ 阶段产物、写范围、守则由 CLI 统一检查
```

核心概念如下：

| 概念 | 说明 |
|---|---|
| Story | 一条需求，对应 `features/<story>.md` 文件 |
| Stage | 当前流程中的阶段：`design`、`review`、`develop`、`test`、`accept` |
| Role | 负责一个阶段的角色，例如设计者、审核者、开发者、测试者 |
| Artifact | 阶段产物，例如 `docs/v0.1.0/design/story-0.1.0-001-r1.md` |
| Guard | 工作区硬约束，例如 SQL 只追加、配置不可修改、数据库文件不可删除 |
| Run | 一条 Story 的运行记录，保存在 `.orca-team-orchestration/runs/` |

每个 Story 文件可以包含多个功能。一次 `start` 会针对文件中的全部功能建立同一份需求快照，不会只挑选其中一部分执行。

### 当前版本能做什么

当前版本已经可以：

- 在安装 Orca 后初始化项目目录与配置；
- 创建、格式校验和列出 Story；
- 通过本地工作台查看项目状态，并编辑各角色的提示词与循环轮次上限；
- 用 `render` 查看某个角色最终会收到的完整提示词；
- 建立 Story 快照与运行记录；
- 用 `start` 派发 Orca worker 自动推进 design → review → develop → test，产物/范围/守则/命令校验通过后写检查点提交；
- 失败或超限时进入 gate（退出码 `7`），`resume` 可续跑未完成的派发或刷新需求快照；
- 全部阶段通过后用 `accept` 记录需求方验收；
- 查看 Story 状态与下一阶段；
- 检查阶段产物、工作区写范围和守则；
- 用 `init --workspace` 把父目录与多个嵌套独立 Git 仓库接入为一个 workspace，并在一次 story 中联动修改多个仓库；
- 检查 Node、Git、配置、Agent 与 Orca 环境；
- 输出适合脚本或 CI 使用的 JSON。

`start` 需要真实的 Orca 运行时来派发 worker；未检测到 Orca CLI 时会以退出码 `4` 结束并提示安装。派发之后的产物质量仍由阶段校验和 worker 决定，工具只做校验、推进、续跑与记录，不会替角色生成设计或代码。

角色提示词目前通过 `render` 命令查看最终渲染结果；真实阶段派发接入后会复用同一个 `PromptRenderer`，无需再维护另一套提示词。

## 2. 安装

`orca-team-orchestration init` 强制要求安装 Orca。先安装 Orca 桌面应用，并确认 CLI 已加入 `PATH`。Orca 的 CLI 命令名按平台不同：

| 平台 | CLI 命令 | 常见位置 |
| --- | --- | --- |
| Linux | `orca-ide` | 安装 Orca 后即在 `PATH` 中 |
| macOS | `orca` | `/Applications/Orca.app/Contents/Resources/bin/orca`（安装 Orca 后该目录通常已在 `PATH`） |
| Windows | `orca` | 安装目录下的 `resources\bin\orca.exe` |

```bash
orca-ide --version   # Linux
orca --version       # macOS / Windows
```

如果提示找不到命令，请先安装 Orca。仅安装本工具或仅打开 Orca 界面都不足以通过该检查；命令必须能在当前终端中执行。也可以用环境变量 `ORCA_TEAM_ORCHESTRATION_ORCA` 直接指定 CLI 的完整路径（设为空字符串则禁用自动探测，主要供测试使用）。

确认 Orca 可用后，在工具源码目录中执行：

```bash
npm ci
npm run build
npm link
```

确认安装成功：

```bash
node --version
git --version
orca-ide --version   # Linux
orca --version       # macOS / Windows
orca-team-orchestration --help
```

如果不想执行 `npm link`，也可以直接使用构建后的入口：

```bash
node /path/to/orca-team-orchestration/dist/src/cli/index.js --help
```

下文统一假定命令 `orca-team-orchestration` 已加入 `PATH`。

### 2.1 启动本地页面

在任意已初始化的项目目录中执行：

```bash
orca-team-orchestration ui
```

页面会自动绑定当前 Git 仓库根目录；多仓 workspace 会自动解析到 workspace 根，无需再设置 `ORCA_TEAM_ORCHESTRATION_REPO`。看到以下输出表示服务已经启动：

```text
Orca Team Orchestration 页面已启动：http://127.0.0.1:5173/
项目目录：/path/to/project
```

浏览器访问 `http://127.0.0.1:5173/`。页面提供：

- 当前项目、Orca 与配置状态；
- 角色提示词编辑：按 flow 顺序列出角色，编辑 `.orca-team-orchestration/roles/<role>.md` 覆盖文件；
- “恢复默认”：删除覆盖文件，回退到内置模板；
- 角色 Agent 绑定：每个角色单独下拉选择 `agents` 池中的任意 agent（如 designer 用 claude、reviewer 用 codex、developer 用 zcode）；
- Agent 池管理：新增/修改/删除 agent 定义（类型、model、effort），写回 `config.yaml` 的 `agents` 段；被角色绑定的 agent 不允许删除；
- 循环轮次上限：`runtime.max_rounds.design_review` / `dev_test`；
- 保存计划预览：写盘前显示将写入或删除的文件与 `config.yaml` 变更；
- 保存与重置，带 revision 冲突检测。

保存只写入角色覆盖文件与 `config.yaml`（轮次上限、角色 `agent` 绑定、`agents` 定义），不会执行 `start` / `test`，也不会启动 Agent 派发。保存前会把旧覆盖文件备份为 `<role>.md.bak`；`config.yaml` 变化时把原配置备份为 `config.yaml.bak`。轮次与 Agent 绑定通过 YAML Document API 更新，原有注释与格式会保留；`agents` 段在定义变化时整段重写。

项目名称、命令、路径、流程、守则等仍通过 CLI `config` 或直接编辑 `config.yaml` 完成。

默认提示词随工具包发布在 `templates/<locale>/`（`zh-CN` 与 `en`），每个语言包含 `system.md` 和四个内置角色模板。自定义角色没有内置模板时使用通用契约。需要替换模板目录时，可设置：

```bash
ORCA_TEAM_ORCHESTRATION_TEMPLATES=/path/to/templates orca-team-orchestration ui
```

`config.locale` 选择语言；所选语言的模板缺失时会整体回退到 `zh-CN`，页面会显示回退警告。

服务默认只监听 `127.0.0.1`，按 `Ctrl+C` 停止。默认编辑当前 Git 仓库根目录；要编辑其他项目：

```bash
orca-team-orchestration ui --repo /path/to/project
```

也可以在源码目录使用 `npm run dev` 启动工具自身的开发页面。

可用接口：

```text
GET  /healthz
GET  /api/status
GET  /api/roles
POST /api/roles/preview
POST /api/roles
```

旧版 `/api/config` 与 `/api/config/preview` 已移除。角色提示词覆盖文件建议提交，`.bak` 不建议提交。

如果 5173 端口已被占用，页面服务会明确报错并退出。停止占用进程后重新执行，或临时改用其他端口：

```bash
orca-team-orchestration ui --port 5174
```

`project.commands.base_url` 是**被测应用**的访问地址，不是页面服务地址；改用其他端口时，只需同步修改需要访问应用的配置。

## 3. 五分钟快速开始

以下步骤把一个已经存在的 Git 项目接入编排流程。所有命令都应在目标项目目录中执行。

### 3.1 确认或创建 Git 仓库

```bash
git status
```

如果提示“不是 Git 仓库”，先初始化：

```bash
git init
git add .
git commit -m "chore: initial project"
```

工具依赖 Git 判断工作区改动和守则基线，因此目标目录必须是 Git 仓库。

### 3.2 接入项目

`init` 会先检查 Orca CLI（Linux 为 `orca-ide`，macOS / Windows 为 `orca`）：

```bash
orca-ide --version   # Linux
orca --version       # macOS / Windows
```

未检测到 Orca CLI 时，命令会提示安装 Orca，以退出码 `4` 结束，并且不会创建配置文件或项目目录。验证 Orca 可执行后，再执行：

```bash
orca-team-orchestration init
```

`init` 会显示检测到的 Orca CLI 路径，自动探测常见的 `package.json` 脚本、源码目录和 SQL 文件。运行命令识别不到时会保持为空，不阻塞后续流程。它还会创建：

```text
.orca-team-orchestration/
  config.yaml
  runs/
  approvals/
features/
docs/
```

`docs/` 下的阶段产物目录（`v<版本>/design/` 等）在运行时按需求版本自动创建，`init` 不预建。

它还会把 `.orca-team-orchestration/runs/` 加入 `.gitignore`，并默认在 `.git/hooks/pre-commit` 安装守则检查（`--no-hook` 可跳过；已有非本工具的 hook 会备份为 `pre-commit.bak`）。Orca 已安装但当前未打开时仍可完成初始化；`init` 只检查可执行文件，不会启动 Orca。配置文件被重复初始化时会拒绝覆盖；只有确认需要重置时才使用 `--force`。

### 3.3 项目命令（可选）

查看配置：

```bash
orca-team-orchestration config --print
```

需要固定启动、测试和访问地址时：

```bash
orca-team-orchestration config \
  --start "npm run dev" \
  --test "npm test" \
  --base-url "http://127.0.0.1:5173/"
```

这些字段不再是必填项。`init` 识别不到时会让它们保持为空，并提示“运行信息未配置”；`start` / `resume` 不会因此阻塞。各角色会在运行前自行识别项目命令和基址：developer 将识别结果写入研发报告的“运行环境”一节，tester 优先复用。项目结构复杂、希望结果稳定可复现时，再用 `config` 固定。

在交互式终端中只执行 `orca-team-orchestration config`，CLI 会逐项询问；脚本或 CI 中应显式传入参数。

`config` 只更新配置，不会启动服务。要使用页面，请在项目目录执行：

```bash
orca-team-orchestration ui
```

然后访问 `http://127.0.0.1:5173/`。页面用于编辑角色提示词、为每个角色绑定 Agent、管理 Agent 池与轮次上限，不再编辑项目命令和路径；这些字段继续使用 `config` 或直接修改 YAML。

### 3.4 创建 Story

```bash
orca-team-orchestration new story-0.1.0-001 --title "午餐抽签"
```

然后编辑 `features/story-0.1.0-001.md`，填写功能清单和验收标准。可使用下面的模板：

```markdown
# story-0.1.0-001 午餐抽签

- 背景: 中午不知道吃什么，点一下随机抽取。
- 依赖: 无
- 明确不做: 不接入后端，不保存历史记录
- 测试数据: 候选菜名 5 条

## 功能清单

- F1 随机抽签：点击按钮从候选项中随机选一个
- F2 展示结果：显示菜名并提供“再抽一次”
- F3 移动端可用：320px 宽度下不出现横向滚动

## 验收标准

- [ ] story-0.1.0-001-1 打开页面能看到“抽签”按钮
- [ ] story-0.1.0-001-2 点击后随机显示一个候选菜名
- [ ] story-0.1.0-001-3 点击“再抽一次”后可以重新抽取
- [ ] story-0.1.0-001-4 320px 宽度下页面没有横向滚动
```

创建文件时，默认会尝试生成一次本地 Git 提交。如果暂时不想提交，可使用：

```bash
orca-team-orchestration new story-0.2.0-001 --title "待办事项" --no-commit
```

### 3.5 校验并查看 Story

```bash
orca-team-orchestration lint story-0.1.0-001
orca-team-orchestration list
```

`lint` 成功时输出 `LINT: PASS`。格式错误会显示文件名、行号和原因。

### 3.6 建立运行快照

先预演，不写入运行状态：

```bash
orca-team-orchestration start story-0.1.0-001 --dry-run --orchestrator orca
```

预演不会创建 `.orca-team-orchestration/runs/story-0.1.0-001.json`，但仍会写入需求快照 `.orca-team-orchestration/runs/story-0.1.0-001/spec.md`。

确认无误后正式开始：

```bash
orca-team-orchestration start story-0.1.0-001 --orchestrator orca
```

正式执行会完成以下操作：

1. 检查 Story 格式与依赖；
2. 把需求复制到 `.orca-team-orchestration/runs/story-0.1.0-001/spec.md`；
3. 记录需求内容的 SHA-256；
4. 在 `.orca-team-orchestration/runs/story-0.1.0-001.json` 中创建运行状态；
5. 探测 Orca、建立编排 Run，并按 `design → review → develop → test` 依次派发 worker；
6. 每个角色完成后校验产物、写范围、守则与角色命令检查：通过则写检查点提交并进入下一阶段，失败则回到本回路起点进入下一轮，超过轮次上限则创建 gate 并以退出码 `7` 结束；
7. 全部阶段通过后停在 `accept`，等待需求方执行 `accept`。

若中途中断（超时、Ctrl-C、崩溃），未完成派发的句柄会保存在 `runs/story-0.1.0-001.json` 的 `pending` 中。`resume` 会先向 Orca 核实该派发是否仍存活：仍存活则继续等待，不会重复派发；若 worker 进程已退出且任务未结算（例如手动停止任务或关闭窗口），则用 `--task` 重新打开同一任务，按原 spec 重新派发同一阶段与轮次：

```bash
orca-team-orchestration resume story-0.1.0-001
```

需求文件在快照后被修改时，`resume` 会拒绝执行；确认后加 `--refresh-spec` 重建快照（若验收范围变化会退回 design 重新评审）：

```bash
orca-team-orchestration resume story-0.1.0-001 --refresh-spec
```

全部阶段通过后记录验收：

```bash
orca-team-orchestration accept story-0.1.0-001
```

### 3.7 查看状态

```bash
orca-team-orchestration status story-0.1.0-001
```

输出会显示状态、下一阶段、编排器、运行 ID、快照路径和各阶段状态。

### 3.8 多仓 workspace（前后端独立仓库）

如果前端和后端是两个**独立 Git 仓库**，只是放在同一个父目录下，用 `init --workspace` 把父目录接入为 workspace：

```text
workspace/                 # 根仓库（workspace）
  api/                     # 关联仓库（独立 Git）
  web/                     # 关联仓库（独立 Git）
```

```bash
cd /path/to/workspace
orca-team-orchestration init --workspace
```

`init --workspace` 会：

1. 检查 Orca；
2. 扫描一级子目录中含 `.git` 的目录作为关联仓库（跳过隐藏目录、`node_modules`、`dist`），也可用 `--repos api,web` 显式指定；
3. 父目录不是 Git 仓库时自动 `git init -q`；
4. 写入 `.orca-team-orchestration/config.yaml`，其中 `project.repos` 记录每个关联仓库的 `name` 与相对路径；
5. 写根目录 `.gitignore` 的 managed block，忽略每个关联仓库路径与 `.orca-team-orchestration/runs/`；
6. 根仓没有 HEAD 且未加 `--no-commit` 时，只提交 `.gitignore` 与配置文件，**不会** `git add -A` 用户文件；
7. 安装根仓与每个子仓的 pre-commit hook。

之后所有命令都在 workspace 根执行（在任一子仓内执行时，工具会自动向上解析到 workspace 根）：

```bash
orca-team-orchestration new story-0.1.0-001 --title "下单页联动改造"
# ... 填写 features/story-0.1.0-001.md ...
orca-team-orchestration lint story-0.1.0-001
orca-team-orchestration start story-0.1.0-001 --dry-run
```

一个 Orca worker 运行在 workspace 根，可以同时编辑 `api/` 与 `web/`。所有配置路径、写范围、产物、守则路径仍然是 **workspace 相对路径**，例如：

```yaml
project:
  repos:
    - name: api
      path: api
    - name: web
      path: web
  paths:
    source:
      - api/src/
      - web/src/
    tests:
      - api/test/
      - web/test/
guards:
  - id: sql-append-only-api
    type: append-only
    paths:
      - api/db/update.sql
    require_header: "-- migration:"
```

多仓语义：

| 能力 | 行为 |
|---|---|
| scope | 分别读取根仓和每个子仓的 `git status`，子仓改动映射为 `api/...`；根仓结果中位于子仓目录下的条目会被过滤 |
| guards | 按仓库收集改动并在对应仓库内执行 `git show HEAD:<path>`；根仓 `db/**` 不会误伤 `api/db/**` |
| `guard run --staged` | 默认只检查根仓暂存区；`--staged-repo api` 检查指定子仓；`--staged-repo all` 检查全部仓库 |
| 检查点提交 | 阶段通过后逐仓提交并输出 `检查点提交 api@abc1234`；根仓只提交 `features/`、`docs/`、证据目录、配置文件与 `.gitignore`，不会提交用户的其他文件 |
| approvals | 审批记录所有仓库的 HEAD（`baselines`）；任一仓库发生新提交后，该仓库的违规自动恢复拦截 |
| hooks | 根仓 hook 执行 `guard run --staged`；子仓 hook 固定 `--repo <workspace>` 并执行 `--staged-repo <name>` |

注意：

- 子仓必须嵌套在 workspace 内（不能是符号链接，也不能是 `.git` 文件的 worktree/submodule）；v1 不支持用 `runtime.worktree` 的 branch 选择器只覆盖某个子仓，配置里只能是 `path:.`。
- 如果子仓路径已经被根仓跟踪，`init --workspace` 会报错并提示先执行 `git rm -r --cached <path>`，不会自动修改索引。
- `project.repos` 只认项目配置；全局配置中的同名段会被忽略。
- 自动探测到的 `start` / `base_url` 只有在唯一值时才写入；多个前端/服务时保持为空，由角色在运行时自行识别，也可用 `config` 固定。

## 4. 编写 Story

### 4.1 文件命名与标题

Story 文件必须放在 `features/` 下，文件名去掉 `.md` 后就是 Story ID：

```text
features/story-0.1.0-001.md  →  story-0.1.0-001
```

标题必须是文件中的第一个非空行：

```markdown
# story-0.1.0-001 午餐抽签
```

Story ID 必须是 `story-<版本>-<序号>` 格式：前缀固定为 `story`，版本是三段数字（如 `0.1.0`），序号是 1 位以上数字（如 `001`、`02`）。示例：`story-0.1.0-001`、`story-1.1.1-02`。标题中的 ID 必须与文件名一致。docs 产物目录中的版本号（`docs/v0.1.0/...`）即从 Story ID 的版本段派生。

### 4.2 可选元数据

标题后可写以下字段：

```markdown
- 背景: 这项需求的起因和用户问题
- 依赖: story-0.1.0-000
- 明确不做: 本次不包含的范围
- 测试数据: 测试所需的固定数据
- 详见: docs/requirements/detail.md
```

多个依赖可用逗号或空格分隔。依赖项尚未验收时，`start` 会拒绝执行；确认可以忽略时加 `--ignore-deps`。

### 4.3 功能清单

`## 功能清单` 为必填章节，至少包含一条功能：

```markdown
## 功能清单

- F1 查看列表：显示所有待办事项
- F2 新增事项：提交后立即显示在列表中
```

每行格式为 `- <功能 ID> <描述>`。功能 ID 可以自由命名，但同一 Story 内不能重复。

### 4.4 验收标准

`## 验收标准` 为必填章节，至少包含一条验收项。列表格式如下：

```markdown
## 验收标准

- [ ] story-0.1.0-001-1 打开页面后能看到待办列表
- [ ] story-0.1.0-001-2 新增待办后，无需刷新即可看到新内容
```

也可以使用表格：

```markdown
## 验收标准

| 验收 ID | 描述 |
|---|---|
| story-0.1.0-001-1 | 打开页面后能看到待办列表 |
| story-0.1.0-001-2 | 新增待办后立即显示 |
```

验收 ID 必须以 `<story>-` 开头，并在 Story 内唯一。Story 文件中的验收标准是最终验收依据，不应只写在聊天记录或设计文档中。

### 4.5 格式检查

检查单条 Story：

```bash
orca-team-orchestration lint story-0.1.0-001
```

检查 `features/` 下的全部 Story：

```bash
orca-team-orchestration lint
```

在自动化脚本中获取 JSON：

```bash
orca-team-orchestration lint story-0.1.0-001 --json
```

## 5. 日常操作流程

推荐按以下顺序工作：

| 步骤 | 操作人 | 操作 |
|---|---|---|
| 1 | 需求方 | 编写 Story，写清功能与可验证的验收标准 |
| 2 | 协调者 | 执行 `lint`，确认需求格式有效 |
| 3 | 协调者 | 用 `start --dry-run` 检查依赖、快照和下一阶段 |
| 4 | 协调者 | 正式 `start`，派发 worker 自动推进阶段并写检查点提交 |
| 5 | 各角色（Orca worker） | 按约定的产物路径完成产物 |
| 6 | 协调者 | 失败或超限时用 `resume` 续跑或处理 gate，`check` 可随时手动校验 |
| 7 | 需求方 | 用 `status` 查看进度，全部通过后执行 `accept` 记录验收 |

`start` 会按 flow 自动派发 Orca worker 并推进阶段；`check` 仍可独立运行，用于在不派发的情况下手动校验产物、写范围、守则与角色命令检查。

### 5.1 查看 Story 列表

```bash
orca-team-orchestration list
```

输出包含 ID、状态、功能数、验收数和标题。默认隐藏已验收的 Story，查看全部：

```bash
orca-team-orchestration list --all
```

机器可读格式：

```bash
orca-team-orchestration list --json
```

状态含义：

| 状态 | 含义 |
|---|---|
| 未开始 | 没有运行记录 |
| 进行中 | 有运行记录，尚未完成测试阶段 |
| 待验收 | 测试阶段已通过，等待人工验收 |
| 已验收 | 已记录验收时间 |
| 非法 | Story 文件格式有错误 |

### 5.2 查看整体状态

```bash
orca-team-orchestration status
```

查看单条 Story：

```bash
orca-team-orchestration status story-0.1.0-001
```

如果需求文件在建立快照后被修改，状态输出会显示“需求文件已变更”。确认变更内容后，用 `resume <story> --refresh-spec` 重建快照；若功能或验收标准发生变化，运行会退回 design 阶段重新评审。存在未完成派发（`pending`）时不能刷新快照，需先 `resume` 等待该派发结束。

## 6. 阶段校验

### 6.1 校验命令

```bash
orca-team-orchestration check <design|review|develop|test> <story> [--round N]
```

例如：

```bash
orca-team-orchestration check design story-0.1.0-001 --round 1
orca-team-orchestration check review story-0.1.0-001 --round 1
orca-team-orchestration check develop story-0.1.0-001 --round 1
orca-team-orchestration check test story-0.1.0-001 --round 1
```

一次检查包含三部分：

```text
ARTIFACT 阶段产物是否存在，章节和首行判定是否符合要求
SCOPE    工作区改动是否位于该阶段允许的写入范围
GUARD    SQL、配置、数据库文件是否违反硬约束
```

全部通过时输出：

```text
STAGE-CHECK: PASS（design story-0.1.0-001 r1）
```

检查失败时会逐项显示原因。使用 `--json` 可获得结构化结果：

```bash
orca-team-orchestration check design story-0.1.0-001 --round 1 --json
```

### 6.2 默认产物要求

默认配置下各阶段产物如下（`<版本>` 从 Story ID 的版本段派生，如 story-0.1.0-001 的产物写入 `docs/v0.1.0/`；角色 `artifact.path` 模板中的 `{{version}}` 变量即代表该版本）：

| 阶段 | 默认产物 | 关键要求 |
|---|---|---|
| design | `docs/v<版本>/design/<story>-r<round>.md` | 包含“目标”“验收映射”“数据库变更”“失败路径”“回滚”章节 |
| review | `docs/v<版本>/review/<story>-r<round>.md` | 首个非空行为 `PASS` 或 `REJECT`；包含“问题清单”“通过条件” |
| develop | `docs/v<版本>/dev/<story>-r<round>.md` | 包含“变更”“自测”“SQL” |
| test | `docs/v<版本>/test/<story>-r<round>.md` | 首个非空行为 `PASS` 或 `FAIL`；包含“用例结果”“证据” |

设计产物示例：

```markdown
# 目标

## 目标

实现午餐随机抽签，并支持重新抽取。

## 验收映射

- F1 → story-0.1.0-001-1、story-0.1.0-001-2
- F2 → story-0.1.0-001-3
- F3 → story-0.1.0-001-4

## 数据库变更

无。

## 失败路径

候选列表为空时显示明确提示，不执行抽取。

## 回滚

删除本轮新增页面与脚本，不涉及数据库变更。
```

审核产物示例：

```markdown
PASS

## 问题清单

无阻塞问题。

## 通过条件

功能清单与验收映射完整，失败路径已覆盖。
```

### 6.3 工作区范围检查

范围检查以 `git status --porcelain` 为基础。执行 `check` 前，工作区中应当只包含当前阶段预期的改动。多仓 workspace 会同时读取根仓和每个关联仓库的状态，子仓改动统一映射为 `api/...`、`web/...` 后再匹配允许范围；根仓 `git status` 里位于子仓目录下的条目会被忽略，由子仓自己的状态负责。

如果存在与本阶段无关的未提交文件，可能出现：

```text
SCOPE FAIL  design 阶段越界改动：src/app.ts
```

处理方式：

1. 确认 `src/app.ts` 是否确实属于当前阶段；
2. 不属于当前阶段时，提交、暂存或移动到其他工作区；
3. 不要为了通过检查而随意删除他人的改动。

### 6.4 轮次

使用 `--round` 指定要检查的轮次。没有显式指定且存在运行记录时，优先使用运行状态中的轮次；否则使用已有产物中的最大轮次。

```bash
orca-team-orchestration check review story-0.1.0-001 --round 2
```

## 7. 守则校验

守则由 `.orca-team-orchestration/config.yaml` 中的 `guards` 定义。手动检查当前工作区：

```bash
orca-team-orchestration guard run
```

只检查指定守则：

```bash
orca-team-orchestration guard run --id sql-append-only
```

多个 ID 可以重复传入或使用逗号分隔：

```bash
orca-team-orchestration guard run --id sql-append-only,no-delete-schema
```

检查暂存区而不是工作区：

```bash
orca-team-orchestration guard run --staged
```

多仓 workspace 下，`--staged` 默认只检查根仓暂存区；检查指定子仓或全部仓库：

```bash
orca-team-orchestration guard run --staged --staged-repo api
orca-team-orchestration guard run --staged --staged-repo all
```

JSON 输出：

```bash
orca-team-orchestration guard run --json
```

### 7.1 三种守则

| 类型 | 规则 | 典型用途 |
|---|---|---|
| `append-only` | 以 `HEAD` 中内容为前缀，只允许在末尾追加 | SQL 迁移文件 |
| `immutable` | 与 `HEAD` 完全一致；默认不允许新增 | `package.json`、受保护配置 |
| `no-delete` | 可以新增或修改，但不能删除行、文件或移动文件 | 数据库结构目录 |

SQL 只追加守则示例：

```yaml
guards:
  - id: sql-append-only
    type: append-only
    paths:
      - db/update.sql
    require_header: "-- migration:"
    message: "SQL 只能追加，新增段以 -- migration: 开头"
```

正确的追加方式：

```sql
-- migration: add priority to todo
ALTER TABLE todo ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
```

守则以 Git 的 `HEAD` 为基准。已提交的历史内容被修改时，即使当前 Git 索引干净，也可能在下次比较中暴露问题。发现违规后应恢复原有内容，并把新内容追加到末尾。

### 7.2 pre-commit hook

`init` 默认在 `.git/hooks/pre-commit` 安装本地检查（`--no-hook` 跳过）：

```sh
#!/bin/sh
# orca-team-orchestration pre-commit guard
exec node "<CLI 入口>" --repo "<仓库根>" guard run --staged
```

- hook 只做本地检查，不联网；违规时提交以退出码 `6` 被拒绝。
- 已存在非本工具的 hook 时会先备份为 `pre-commit.bak` 再接管。
- 重新 `init`（或再次安装）会刷新 hook 内容；`doctor` 会报告 hook 状态。
- 多仓 workspace 的每个子仓也会安装 hook，内容为 `guard run --staged --staged-repo <name>`，并通过 `--repo` 固定 workspace 根：

  ```sh
  #!/bin/sh
  # orca-team-orchestration pre-commit guard
  exec node "<CLI 入口>" --repo "<workspace 根>" guard run --staged --staged-repo "api"
  ```

  在子仓里正常 `git commit` 即可触发；它只检查该子仓的暂存区。

### 7.3 守则审批（带审计放行）

确认某次违规可以放行时，为当前基线创建审批记录：

```bash
orca-team-orchestration guard allow sql-append-only --reason "线上紧急修表" --by 张三
```

- 审批写入 `.orca-team-orchestration/approvals/<时间戳>-<id>.json`，记录守则 ID、原因、申请人和基线 commit。
- 审批只对当前 `HEAD` 基线有效，下一次提交后自动失效；`guard run` 与 `check` 会把已放行违规列为 `APPROVED` 而不再阻塞。
- 多仓 workspace 的审批会记录所有仓库的 HEAD（`baselines: { workspace, api, web }`），输出形如 `基线 workspace@abc123 api@def456`；只有对应仓库产生新提交时该仓库的违规才恢复拦截。
- 旧版审批没有 `baselines` 时仍可读取，但只对根仓（workspace）违规生效。
- 审批不改变规则本身，只让某次违规带审计地通过。
- 查看审批记录：

```bash
orca-team-orchestration guard approvals
```

## 7.4 explain：下一步该做什么

```bash
orca-team-orchestration explain story-0.1.0-001
```

输出当前状态、下一步阶段、原因（未完成派发、gate、需求漂移、缺少的产物）和建议命令，帮助协作者在不读源码的情况下接手。机器可读：

```bash
orca-team-orchestration explain story-0.1.0-001 --json
```

## 8. 配置说明

### 8.1 配置文件位置

项目配置：

```text
.orca-team-orchestration/config.yaml
```

全局默认配置：

```text
$XDG_CONFIG_HOME/orca-team-orchestration/config.yaml
```

Windows 下未设置 `XDG_CONFIG_HOME` 时，默认位置为：

```text
%APPDATA%\orca-team-orchestration\config.yaml
```

配置合并顺序为：内置默认值 → 全局配置 → 项目配置。

- `project`、`runtime`、`agents` 按对象深度合并；
- `roles`、`flow`、`guards`、`checks` 由项目配置整体替换；
- 数组整体替换，不做拼接；
- 未知字段会导致配置校验失败，拼写错误不会静默忽略；
- `project.repos` 只认项目配置，全局配置中的同名字段会被忽略，避免一台机器上的全局默认影响所有非 workspace 项目。

### 8.2 常用配置

```yaml
version: 1
locale: zh-CN

project:
  name: demo
  repos:                      # 可选：多仓 workspace；缺省为单仓
    - name: api
      path: api
    - name: web
      path: web
  commands:
    start: npm run dev
    test: npm test
    build: npm run build
    base_url: http://127.0.0.1:5173/
  paths:
    features_dir: features
    docs: docs
    source:
      - src/
    tests:
      - test/
    db: db/update.sql
    evidence: docs/v{{version}}/test/evidence

runtime:
  orchestrator: orca
  shell: auto
  timeout_minutes: 60
  max_rounds:
    design_review: 3
    dev_test: 3
  checkpoint_commits: true
  push: false
```

`runtime.push` 必须为 `false`。工具不会推送 Git 提交。新项目默认使用 `orca`；`auto` 在检测不到 Orca 时会提示安装，不存在其他编排器回退路径。

`project.repos` 的约束：

- `name` 唯一（大小写不敏感），不能是 `workspace`、`all`、`root` 或 `.`；建议使用安全字符（字母、数字、`.`、`_`、`-`）。
- `path` 是 workspace 相对 POSIX 路径，必须是已存在的嵌套 Git 仓库；不能是绝对路径、不能含 `..`/`.` 段、反斜杠或 glob 元字符，不能以点或空格结尾。
- 关联仓库之间、关联仓库与根不能路径重叠（例如不能同时配置 `api` 与 `api/web`）。
- 配置了 `repos` 后，`runtime.worktree` 只能是 `path:.`（或缺省）；branch/worktree 选择器只覆盖单个仓库，v1 不支持。
- 根仓、子仓、`features/`、`docs/` 等仍使用 workspace 相对路径；根仓的 `.gitignore` 必须忽略各子仓路径（`init --workspace` 自动写入 managed block）。

### 8.3 阶段与角色

`flow` 将阶段关联到角色：

```yaml
flow:
  design: designer
  review:
    - reviewer
  develop: developer
  test:
    - tester
  accept: coordinator
```

`review` 和 `test` 可以配置多个角色，也可以设为 `null` 跳过。多个角色时，必须全部通过才算该阶段通过。

角色的 `writes` 决定阶段允许改动的范围。开发阶段还会额外允许修改 `project.paths.source`、`project.paths.tests` 和 `project.paths.db` 指定的路径。多仓 workspace 下这些路径仍是 workspace 相对路径（例如 `api/src/`），scope 会把子仓改动映射到相同前缀后再匹配。

修改配置后，建议立即运行：

```bash
orca-team-orchestration config --print
orca-team-orchestration doctor
```

第一条命令会加载并校验合并后的配置；第二条命令会检查运行环境。

### 8.4 网页编辑范围

`npm run dev` 页面可以：

- 编辑 `.orca-team-orchestration/roles/<role>.md`，整文件覆盖该角色的默认提示词；
- 恢复默认：删除对应覆盖文件；
- 修改 `runtime.max_rounds.design_review` / `dev_test`（1–100 的整数）；
- 为每个角色选择绑定的 agent（从 `agents` 池下拉，写入 `roles.<role>.agent`）；
- 管理 `agents` 池：新增/更新/删除 agent 定义（`kind`、`model`、`effort`）。

页面不再编辑 `project.name`、命令和路径；这些字段使用 `orca-team-orchestration config` 或直接编辑 YAML。`flow`、`guards`、`checks`、`runtime` 的其他字段、`roles` 除 `agent` 外的字段和 `locale` 仍需直接编辑 YAML。

保存时服务端会：

- 只接受 `config.roles` 中已定义的角色，未知角色直接拒绝；
- 校验角色名与 agent 名可安全用作文件名：以 Unicode 字母或数字开头，后续可含字母、数字、`.`、`_`、`-`；拒绝路径分隔符、`..`、首尾点/空格、Windows 保留名，以及仅大小写不同的重名；
- 将单个角色提示词限制为 64 KiB；
- 把空内容或与默认内容完全一致的提示词视为“继承默认”，并删除覆盖文件；
- 拒绝绑定到不存在的 agent、删除仍被角色绑定的 agent、清空整个 `agents` 池等非法组合；
- 生成的 `config.yaml` 在写盘前按完整校验管线复核，校验失败即中止并保留原文件；
- 使用 config revision 与每个角色覆盖文件的 revision 做乐观并发控制；任一过期都会返回冲突，页面保留草稿并提示重置。

所有校验通过后才开始写盘。写入前备份旧覆盖文件；任何一步失败时尽力用备份回滚已处理的文件。多文件写入无法做到严格事务，极端崩溃仍可能留下部分文件。

### 8.5 角色提示词与模板

默认提示词位于工具包的 `templates/zh-CN/` 与 `templates/en/`：

```text
templates/<locale>/
  system.md
  designer.md
  reviewer.md
  developer.md
  tester.md
```

- `system.md` 是系统段，所有角色共享；
- 四个内置角色模板分别对应 `designer`、`reviewer`、`developer`、`tester`；
- 自定义角色没有同名模板时，渲染会使用根据配置生成的通用契约；
- 项目覆盖文件位于 `.orca-team-orchestration/roles/<role>.md`，存在时整文件替换默认契约；
- `init` 不会创建 `roles/`，第一次在页面保存覆盖时才创建；
- 恢复默认会删除覆盖文件，删除前把旧文件备份为 `<role>.md.bak`。

查看某个角色最终会收到的完整提示词：

```bash
orca-team-orchestration render designer story-0.1.0-001 --round 2
orca-team-orchestration render reviewer story-0.1.0-001 --previous docs/v0.1.0/review/story-0.1.0-001-r1.md
orca-team-orchestration render tester story-0.1.0-001 --json
```

`render` 不要求项目配置里已经填好命令，也不要求 Orca 可用。需求优先读取 `.orca-team-orchestration/runs/<story>/spec.md` 快照；快照不存在时读取 `features/<story>.md` 并输出 warning。`--stage` 可指定角色所属阶段，`--previous` 附加上一轮报告，`--json` 输出结构化结果。

## 9. 环境自检

执行：

```bash
orca-team-orchestration doctor
```

检查项包括：

- Node.js 版本是否不低于 20；
- 当前目录是否为有效 Git 工作区；
- 配置是否可解析和加载；
- `start`、`test`、`base_url` 是否完整；
- Agent 可执行文件是否在 `PATH` 中；
- 模型是否已指定；
- Story 文件格式是否有效；
- Orca 是否安装；缺失时该项为 `FAIL`；
- 运行目录是否存在；
- 多仓 workspace：根是否 Git 顶层、每个关联仓库是否存在且为独立 Git 顶层、是否有 HEAD、hook 状态、根 `.gitignore` 是否覆盖子仓和运行目录、`runtime.worktree` 选择器、审批在当前各仓基线下是否仍有效。仓库缺失/非法为 `FAIL`，缺 hook、缺 HEAD 或 ignore 未覆盖为 `WARN`。

JSON 输出：

```bash
orca-team-orchestration doctor --json
```

`WARN` 表示建议处理但不会阻止基础命令；`FAIL` 需要优先修复。

## 10. 命令速查

| 命令 | 作用 |
|---|---|
| `orca-team-orchestration init [--force] [--baseline] [--orca-add] [--no-hook]` | 检查 Orca 后接入当前 Git 仓库（默认安装 pre-commit hook） |
| `orca-team-orchestration init --workspace [--repos a,b] [--no-commit] [--force] [--no-hook] [--orca-add]` | 把父目录接入为多仓 workspace：自动建根仓、发现/校验嵌套仓库、写配置与 managed `.gitignore`、安装根+子仓 hook |
| `orca-team-orchestration config [--print]` | 查看项目命令与配置 |
| `orca-team-orchestration config --start CMD --test CMD --base-url URL` | 非交互固定命令和基址（可选） |
| `orca-team-orchestration new <story> [--title 标题] [--no-commit]` | 创建 Story 骨架 |
| `orca-team-orchestration list [--all] [--json]` | 列出 Story |
| `orca-team-orchestration lint [<story>] [--json]` | 校验一条或全部 Story |
| `orca-team-orchestration start [<story>] [--dry-run] [--orchestrator auto\|orca]` | 建立快照并派发 Orca worker 自动推进阶段 |
| `orca-team-orchestration start <story> --ignore-deps` | 忽略尚未验收的依赖 |
| `orca-team-orchestration resume <story> [--refresh-spec]` | 续跑未完成的派发、处理 gate 或刷新需求快照 |
| `orca-team-orchestration accept <story>` | 全部阶段通过后记录需求方验收 |
| `orca-team-orchestration status [<story>] [--json]` | 查看运行状态 |
| `orca-team-orchestration check <stage> <story> [--round N] [--json]` | 校验阶段产物、范围、守则和角色命令检查 |
| `orca-team-orchestration render <role> <story> [--round N] [--stage S] [--previous PATH] [--json]` | 打印渲染后的角色提示词 |
| `orca-team-orchestration explain <story> [--json]` | 解释下一步该做什么、为什么 |
| `orca-team-orchestration guard run [--id ID] [--staged] [--staged-repo name\|all] [--json]` | 单独执行守则校验（含审批豁免） |
| `orca-team-orchestration guard allow <id> --reason 原因 [--by 姓名]` | 为当前基线的守则违规留痕放行 |
| `orca-team-orchestration guard approvals [--json]` | 列出最近的守则审批记录 |
| `orca-team-orchestration ui [--port N]` | 启动当前项目的角色提示词配置页面 |
| `orca-team-orchestration doctor [--json]` | 检查环境 |

全局参数：

```bash
orca-team-orchestration --repo /path/to/project status
```

不传 `--repo` 时，工具先找当前 Git 顶层；如果那里没有配置，会继续向上查找 `project.repos` 包含该仓库的 workspace 根。因此在 `api/` 或 `web/` 子仓内执行命令也会自动落到 workspace 根。显式 `--repo` 始终优先。

也可以设置环境变量：

```bash
export ORCA_TEAM_ORCHESTRATION_REPO=/path/to/project
orca-team-orchestration list
```

Orca CLI 的自动探测顺序为：`PATH` 中的 `orca-ide` → `PATH` 中的 `orca`（校验 `--version` 输出，避免误认同名命令）→ 平台默认安装位置（macOS 的 `/Applications/Orca.app/Contents/Resources/bin/orca`、Windows 的 `%LOCALAPPDATA%\Programs\Orca\resources\bin\orca.exe` 等）。也可以用环境变量直接指定：

```bash
export ORCA_TEAM_ORCHESTRATION_ORCA=/path/to/orca
orca-team-orchestration init
```

设为空字符串（`ORCA_TEAM_ORCHESTRATION_ORCA=''`）会禁用自动探测，主要用于测试隔离。

## 11. 退出码与结果判断

| 退出码 | 含义 | 建议操作 |
|---|---|---|
| `0` | 成功 | 继续下一步 |
| `1` | 校验失败 | 查看 `ARTIFACT`、`SCOPE` 或命令检查输出并修复 |
| `2` | 用法错误 | 检查命令、参数和位置是否正确 |
| `3` | 配置或 Story 文件非法 | 根据提示修正 YAML 或 Markdown |
| `4` | 编排器不可用或等待 worker 超时 | 确认 Orca CLI（Linux 为 `orca-ide`，macOS / Windows 为 `orca`）可执行、Run 可用；超时用 `resume` 继续等待 |
| `5` | Agent 不可用 | 检查 Agent 安装、认证和命令；`start`/`resume` 派发前会预检 flow 中各角色绑定的 agent 命令（claude/codex/zcode/opencode/qoder/codebuddy，其中 qoder 检查 `qodercli`），缺失时直接以 `5` 结束并提示安装或改绑 |
| `6` | 守则违规 | 根据 `guard id` 和“修法”处理 |
| `7` | gate 待处理（轮次超限或 worker 提出需决策的问题） | 处理 `.orca-team-orchestration/runs/<story>.json` 的 gate 后 `resume` |

在脚本中应同时检查退出码和输出，不要只匹配日志文本。

## 12. 目录与数据

接入后，项目中的主要文件如下：

```text
<repo>/
  .gitignore
  .orca-team-orchestration/
    config.yaml                 # 项目配置，建议提交
    config.yaml.bak             # 页面保存轮次前的上一版配置，不建议提交
    roles/
      designer.md               # 可选：项目覆盖提示词，建议提交
      designer.md.bak           # 页面保存前的旧覆盖，不建议提交
    approvals/                  # 后续审批使用
    runs/                       # 运行态，不提交
      story-0.1.0-001.json
      story-0.1.0-001/
        spec.md
  features/
    story-0.1.0-001.md                # 需求源文件，建议提交
  docs/
    v0.1.0/                    # 版本目录从 Story ID 的版本段派生，运行时自动创建
      design/
      review/
      dev/
      test/
        evidence/
```

重要原则：

- `features/<story>.md` 是用户维护的需求源文件；
- `.orca-team-orchestration/runs/<story>/spec.md` 是一次运行的只读需求快照；
- CLI 不会把运行状态写回需求文件；
- 不要把 `.orca-team-orchestration/runs/` 提交到版本库；
- 产物目录和审批目录是否提交，由团队审计要求决定。

多仓 workspace 的目录形态：

```text
<workspace>/
  .gitignore                    # managed block 忽略 /api/、/web/、runs/
  .orca-team-orchestration/     # 与单仓相同，配置/运行态/审批都在根
  features/
  docs/
  api/                          # 独立 Git 仓库，根仓忽略
    .git/hooks/pre-commit       # --staged-repo api
    db/update.sql
  web/                          # 独立 Git 仓库，根仓忽略
    .git/hooks/pre-commit       # --staged-repo web
```

根仓只负责需求、文档、配置和检查点；`api/`、`web/` 的源码提交分别落在各自仓库。运行状态与审批文件始终保存在 workspace 根。

### 12.1 自带示例（examples/）

仓库内置两个可直接试跑的项目：

- `examples/static-site/`：零依赖静态页面（午餐抽签），演示最小配置下的 design → review → develop → test → accept 主流程；
- `examples/todo-app/`：Node 小项目，演示三条守则拦截、`guard allow` 审批过期与 developer 的 `run_checks` 命令检查。

每个目录都有自己的 `README.md`，从 `lint`、`init --baseline` 到 `start --dry-run` 的命令都能直接复制执行。示例里的 `features/*.md` 均通过 `lint`，并由 `test/examples.test.ts` 在 CI 中持续校验。

## 13. 常见问题

### 提示“不是 git 仓库”

先进入目标项目，再执行 `git init`。也可以使用 `--repo` 指向正确目录：

```bash
orca-team-orchestration --repo /path/to/project init
```

如果这是“父目录 + 多个独立子仓”的结构，不要手动在父目录 `git init` 后再走普通 `init`：请使用多仓入口，它会正确处理嵌套仓库和 `.gitignore`：

```bash
cd /path/to/workspace
orca-team-orchestration init --workspace
```

### 提示“未找到 config.yaml”

当前目录尚未接入：

```bash
orca-team-orchestration init
```

### `init` 提示配置已存在

默认不会覆盖现有配置。先备份并检查现有文件；确实需要重建时：

```bash
orca-team-orchestration init --force
```

`--force` 会覆盖项目配置，请确认没有需要保留的自定义内容。

### 为什么根仓 `.gitignore` 要写 `/api/`、`/web/`

子仓是独立 Git 仓库，父目录的 Git 只应跟踪 workspace 自己的需求、文档和配置。如果不忽略子仓，父仓会把子仓内容当成普通文件（或 gitlink）再次跟踪，导致 scope、守则和检查点重复计算。`init --workspace` 会写入带起止标记的 managed block：

```gitignore
# >>> orca-team-orchestration managed >>>
/api/
/web/
.orca-team-orchestration/runs/
# <<< orca-team-orchestration managed <<<
```

如果子仓路径已经被根仓跟踪，`init --workspace` 会拒绝继续并提示：

```bash
git rm -r --cached api
```

工具不会自动修改索引，避免误删已跟踪内容。

### 为什么多仓不能使用 branch/worktree 选择器

`runtime.worktree` 的 branch/worktree 选择器只作用于一个仓库；多仓场景下无法同时为根仓和多个子仓选择同一组工作区。v1 要求 worker 直接运行在 workspace 根，配置只允许 `path:.`。如果需要隔离，请在 workspace 外层复制目录或使用独立环境，而不是只给某个子仓切 worktree。

### 依赖 manifest（package.json / lockfile）如何放行

多仓 init 会把检测到的源码/测试目录写入 `project.paths.source` / `tests`，依赖 manifest 是否可写仍沿用现有规则：只有位于这些目录或角色 `writes` 内的文件才被允许。如需让 developer 修改 `api/package.json` 或 `web/package-lock.json`，把它们加入对应角色的 `writes`（或把仓库根加入 `paths.source`，但范围会更宽）：

```yaml
roles:
  developer:
    writes:
      - docs/v{{version}}/dev/
      - api/package.json
      - api/package-lock.json
```

修改后运行 `orca-team-orchestration check develop <story>` 确认 scope 判定符合预期。

### `init` 提示“运行信息未配置”

这不是阻塞项。各角色会在运行前自行识别启动、测试命令和页面基址，developer 会把结果写入研发报告“运行环境”一节，tester 优先复用。

如果希望结果稳定、可复现，可以随时固定：

```bash
orca-team-orchestration config --start "npm run dev" --test "npm test" --base-url "http://127.0.0.1:5173/"
```

### `start` 提示依赖尚未验收

先完成依赖 Story。如果业务上确认可以并行开始：

```bash
orca-team-orchestration start story-0.2.0-001 --ignore-deps
```

### `start` 返回退出码 4

`4` 表示编排器不可用或等待 worker 超时。先确认 Orca 可执行并处于可用状态：

```bash
orca-team-orchestration doctor
orca-team-orchestration status story-0.1.0-001
```

如果 `doctor` 提示找不到 Orca CLI（Linux 为 `orca-ide`，macOS / Windows 为 `orca`），请安装 Orca 后重试。若是派发后等待超时，未完成派发的句柄已保存在 `runs/story-0.1.0-001.json` 的 `pending` 中；用 `resume` 继续等待，若 worker 已被停止或退出，`resume` 会用 `--task` 重新打开同一任务并重新派发。阶段产物也可以按配置由现有流程生成，再用 `check` 校验。

### `lint` 显示行号错误

根据提示修正对应行。最常见原因是标题 ID 与文件名不一致、功能 ID 重复、验收 ID 前缀错误，或缺少必填章节。

### `check` 产物缺失

确认 Story ID、阶段轮次和配置中的产物路径一致。默认格式为（`v<版本>` 来自 Story ID 的版本段，如 story-0.1.0-001 对应 `docs/v0.1.0/`）：

```text
docs/v<版本>/<stage>/<story>-r<round>.md
```

### `check` 报告越界改动

`check` 会把工作区中所有未提交改动纳入范围判断。先处理与本阶段无关的改动，再重新执行。不要直接用重置命令丢弃未知来源的改动。

### 守则持续失败

守则以 `HEAD` 的版本为基准。恢复被改动的历史内容，将新内容追加到文件末尾。SQL 守则启用 `require_header` 时，追加段的第一条非空内容必须带指定前缀。

### Orca 未安装

`init` 和 `auto` 编排模式都要求 Orca 已安装。未检测到 Orca CLI 时会以退出码 `4` 结束，并提示：

1. 安装 Orca 桌面应用；
2. 确保 Orca CLI 已加入 `PATH`（Linux 为 `orca-ide`，macOS / Windows 为 `orca`）；
3. 运行 `orca-ide --version`（Linux）或 `orca --version`（macOS / Windows）验证；
4. 重新执行原命令。

也可以设置环境变量 `ORCA_TEAM_ORCHESTRATION_ORCA` 直接指定 CLI 的完整路径。检查失败时 `init` 不会写入任何项目文件，避免留下半初始化状态。Orca 已安装但未启动时，`init` 仍会成功；自动启动和运行态检查由后续编排器能力负责。

### `start` 返回退出码 5（agent 命令缺失）

派发前工具会检查 flow 中各角色绑定的 agent 命令是否在本机 `PATH` 中（claude/codex/zcode/opencode/qoder/codebuddy；qoder 检查 `qodercli`）。任一缺失即退出码 `5`，提示缺哪个命令，且不会创建 run、不会进入 Orca。安装对应 CLI 并确认可执行，或在 `.orca-team-orchestration/config.yaml` 的 `agents` 池把角色改绑到已安装的 agent 后重试。`doctor` 的 agent 项也会提前给出 `WARN`。

### 浏览器打不开页面

先确认启动页面服务的终端仍保持运行，并检查该终端是否输出：

```text
Orca Team Orchestration 页面已启动：http://127.0.0.1:5173/
```

然后在另一个终端执行：

```bash
curl -I http://127.0.0.1:5173/
```

正常情况下应返回 `HTTP/1.1 200 OK`。如果提示连接失败，请检查：

- 是否只执行了 `orca-team-orchestration config`；该命令不会启动页面；
- `npm run dev` 是否因端口占用、TypeScript 构建失败或 JavaScript 错误退出；
- 浏览器地址和终端输出的端口是否一致；
- 是否误把 `127.0.0.1` 写成了其他主机名。

### 页面能修改哪些配置

页面支持编辑各角色的提示词覆盖文件、恢复默认，以及修改设计⇄审核、开发⇄测试的轮次上限。项目命令、路径、Agent 定义、流程、守则与检查项仍需直接编辑 YAML 或使用 CLI。完整范围见 8.4。

### 页面保存会改动哪些文件

- 提示词写入 `.orca-team-orchestration/roles/<role>.md`；已有文件会先备份为 `<role>.md.bak`；
- 恢复默认会删除对应覆盖文件，旧内容保留在 `.bak`；
- 轮次写入 `.orca-team-orchestration/config.yaml`，原文件备份为 `config.yaml.bak`。轮次更新会保留 YAML 注释和格式。

页面不会执行命令，也不会启动 Agent 派发。

### 保存提示“配置或提示词已被其他窗口修改”

页面使用 config revision 与每个角色覆盖文件的 revision 做冲突检测。任一 revision 落后于磁盘时，保存会被拒绝，当前草稿会保留。点击“重置”重新读取最新内容，再重新编辑并保存，避免覆盖其他窗口的改动。

### `render` 提示缺少需求文件

`render` 优先读取 `.orca-team-orchestration/runs/<story>/spec.md`；没有快照时读取 `features/<story>.md`。两处都不存在时会报错。先确认 Story ID，或执行 `start --dry-run` 生成快照。

## 14. 安全与协作建议

- 需求文件变更应走评审，不要在运行中静默替换验收标准；
- 每次开始前先执行 `lint` 和 `start --dry-run`；
- 阶段产物、改动的源码和测试证据应一起评审；
- 审核阶段默认只允许写审核文档，不应修改源码；
- 提交前执行 `guard run --staged`；
- 遇到不理解的工作区改动，先检查 `git diff` 和 `git status`，不要直接覆盖或删除；
- 工具配置中的 `runtime.push` 必须保持 `false`，推送由团队按自己的流程完成。

## 15. 后续版本说明

已经完成的多仓能力包括：`init --workspace`、嵌套仓库校验、多仓 scope/guards/检查点、逐仓 hook、按仓审批基线、默认只查根仓的 `--staged` 与 `--staged-repo` 选择器、祖先 workspace 解析、`doctor` workspace 检查，以及 `/api/status` 的 `workspace` / `repos` 字段。

设计文档中已经规划但当前版本尚未开放的命令和入口包括：

- 完整初始化配置页面 `init --ui` / `config --ui`（5173 页面已支持角色提示词、角色 Agent 绑定、Agent 池与轮次编辑）；
- 旧原型迁移 `migrate`；
- 多仓的 per-repo `commands`（当前由 init 合成顶层命令）；
- 关联仓库的 branch/worktree 选择器与非嵌套仓库布局；
- 真实 Orca worker 端到端联调与浏览器驱动落地（`test/e2e-orca.test.ts` 骨架已就位，默认跳过，Linux + `ORCA_E2E=1` 时执行只读探测；三平台 CI 矩阵见 `.github/workflows/ci.yml`）。

核心编排闭环（`start` 自动派发、阶段推进、失败回路、gate、检查点提交、`resume`、`accept`）、Orca Agent 适配器、pre-commit hook、`guard allow` 审批、`explain` 与多仓 workspace 已接入。这些剩余能力上线前，请以本手册的命令表和 `orca-team-orchestration --help` 为准。

## 16. 本地开发与贡献

本仓库既是 `orca-team-orchestration` 的源码，也是工具自身的自托管配置示例。修改工具本身时按以下步骤开发：

```bash
npm install
npm run typecheck
npm test        # 先编译到 dist/，再运行 node --test
npm run dev     # 编译并启动本地页面 http://127.0.0.1:5173/
```

### 16.1 仓库结构

| 路径 | 说明 |
|---|---|
| `src/cli/` | 命令入口、帮助文本与参数解析 |
| `src/core/` | 配置、Story、守则、状态、runner、workspace 等核心逻辑 |
| `src/adapters/orca/` | Orca 编排适配器 |
| `src/ui/`、`public/` | 本地配置页面的 HTTP 服务与静态资源 |
| `templates/` | `zh-CN` / `en` 角色提示词与产物模板 |
| `examples/` | 可直接运行的示例项目 |
| `test/` | `node:test` 测试与临时仓库 helper |
| `docs/`、`features/` | 本仓库自托管时的阶段产物与需求文件目录 |

根目录的 `.orca-team-orchestration/config.yaml` 与 `roles/` 覆盖提示词建议提交；`runs/` 以及页面保存产生的 `.bak` 文件属于本地运行态，已在 `.gitignore` 中排除。`dist/`、`node_modules/`、日志和编辑器文件同样不提交。

### 16.2 提交前检查

```bash
npm run typecheck
npm test
```

CI 配置位于 `.github/workflows/ci.yml`，覆盖 Linux / macOS / Windows 与 Node.js 20 / 22。真实 Orca 端到端探测只在设置了 `ORCA_E2E=1` 且本机检测到 Orca CLI（Linux 为 `orca-ide`，macOS / Windows 为 `orca`）时执行，其余环境会自动跳过。

提交信息建议使用 Conventional Commits（如 `feat: ...`、`fix: ...`、`docs: ...`），并保持单个提交只做一类改动。
