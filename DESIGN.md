# orca-team-orchestration 设计文档 v0.1

> 状态：核心设计与多仓 workspace 已实现（0.0.0）
> 日期：2026-10-25
> 关联原型：`~/.cockpit`（bash 版）、`~/Desktop/orca-demo`（示例）、`~/Desktop/aaa`（试用项目）

## 1. 背景与目标

现在的原型已经验证了流程本身：角色契约、阶段门槛、产物校验、SQL 只追加、检查点提交。
问题在于它绑定了本机环境：bash 脚本、`~/.cockpit` 全局目录、Orca、固定的四个角色和路径规则。

本项目把它重做成一个可开源、可跨平台、可配置的工具：

- **任意项目**：`orca-team-orchestration init` 一次接入；之后一条需求写一个 `features/<story>.md`，`start` 该 story 即可开发其中全部功能。
- **任意机器**：macOS / Linux / Windows 原生可用，不要求 bash。
- **Orca 为前提**：`init` 必须检测到 Orca CLI（Linux 为 `orca-ide`，macOS / Windows 为 `orca`；探测顺序为 PATH 中 `orca-ide` → 校验过版本的 `orca` → 平台默认安装位置，可用 `ORCA_TEAM_ORCHESTRATION_ORCA` 覆盖）；缺失时提示安装并终止，不提供静默降级。
- **配置驱动**：角色数量、每个角色用哪个 agent、哪个模型、产物路径、守则，全在配置文件里。
- **规则可机检**：配置里的每条硬约束都对应一个真实校验，而不是只写在 prompt 里。
- **多仓联动**：前后端是两个独立 Git 仓库时，把共同父目录接入为 Workspace，让一条 Story 同时约束根仓与各子仓，而不是拆成多条互不感知的 Story。

### 非目标（v1）

- 不做 Web 看板；看板用 CLI 输出 + 仓库产物。
- 不做完整的 DAG 编排；流程固定，角色可配。
- 不做远程 worker、云端执行、多机调度。
- 不做 agent 的模型路由/负载均衡。
- 多仓 v1 不做 per-repo commands、非嵌套仓库、branch/worktree 选择器，也不支持 `.git` 为文件的 worktree/submodule 作为关联仓库。

## 2. 核心概念

| 概念 | 定义 |
|---|---|
| Story | 一条需求，一个文件 `features/<story>.md`；文件内可含多个功能，验收标准是唯一来源 |
| Stage | 流程中的一步：design / review / develop / test / accept |
| Role | 执行某个 Stage 的角色，由配置定义，可以是任意数量 |
| Dispatch | 某个 Stage 某轮的一次权威执行 |
| Artifact | 阶段产物，路径与格式由配置决定 |
| Guard | 对工作区改动的硬约束（只追加、不可改、不可删） |
| Run | 一条 Story 的完整执行记录，可续跑 |
| Orchestrator | 负责把 Dispatch 交给 agent 的 Orca 适配器 |
| Workspace | 多仓模式下的根仓库，承载需求、文档、配置、运行态与审批 |
| Linked repo | 嵌套在 Workspace 内的独立 Git 仓库，以 `project.repos` 登记，路径与改动统一映射为 workspace 相对路径 |

三层分离，互不代替：

1. **编排层**：谁在什么时候执行哪个角色。
2. **规则层**：角色看到什么指令、产物写到哪里、格式是什么。
3. **校验层**：改了什么、能不能通过。只有这一层是硬约束。

## 3. 目标使用体验

```bash
# 新机器 / 新项目，一次：打开本地页面点选（也可直接写 YAML）
npx orca-team-orchestration init

# 启动本地只读工作台，查看配置、依赖状态与常用命令
npm run dev

# 需求方在 features/<story>.md 里写需求与功能清单（也可用 orca-team-orchestration new 生成骨架）
orca-team-orchestration new story-0.1.0-001 --title "午餐抽签"

# 查看已有 story 并选择一条开始开发；不带参数时交互选择
orca-team-orchestration list
orca-team-orchestration start story-0.1.0-001
```

- 一个文件 = 一条 story；文件里的功能清单有几条，就开发几条，不拆半条。
- 初始化和默认编排必须使用 Orca；未安装时提示安装并终止。`auto` 不再降级到 `sequential`。
- Orca 编排器统一负责派发，本地工作台只读展示配置和运行依赖。
- 中断后 `orca-team-orchestration resume story-0.1.0-001` 从状态文件继续。

## 4. 架构

```
CLI
 ├─ InitUI（本地回环页面 → 写 config + roles/templates 覆盖文件）
 └─ ConfigLoader（全局 + 项目合并、校验）
     └─ StageRunner
         ├─ PromptRenderer（默认/覆盖模板 + 配置 + story + 轮次 + 上轮报告）
         ├─ Orchestrator adapter
         │    └─ orca       （Run / Task / Dispatch / gate）
         ├─ Checks
         │    ├─ artifacts（存在、章节、首行结论）
         │    ├─ scope    （角色可写路径）
         │    └─ guards   （append-only / immutable / no-delete）
         ├─ CheckpointCommitter（本地提交，绝不 push）
         └─ RunState（.orca-team-orchestration/runs/<story>.json）
```

`StageRunner` 是唯一知道流程的地方。adapter 只负责“把一份 prompt 交给一个 agent，并回报结果”，不知道角色语义。

实现状态（0.0.0）：`PromptRenderer` 与 `render` 命令已落地，默认模板位于 `templates/<locale>/`，项目覆盖文件为 `.orca-team-orchestration/roles/<role>.md`。`StageRunner`（`src/core/runner.ts`）与 Orca adapter（`src/adapters/orca/adapter.ts`）已接入核心闭环：`start` 探测 Orca、建立 Run、按 flow 派发 worker、等待 `worker_done`/问题、校验产物/范围/守则/命令检查、更新阶段轮次与失败回路、超限或需决策时创建 gate，并写本地检查点提交；`resume` 续跑未完成派发（先核实 Orca liveness：存活则等待，已退出且任务未结算则用 `--task` 重开同一任务）或刷新快照，`accept` 记录验收。adapter 通过 `Orchestrator` 接口注入，runner 用 Stub 测试、真实链路用 `OrcaAdapter`。5173 页面可编辑角色提示词、角色 Agent 绑定与 agents 池（增改删定义）以及轮次上限；项目命令和路径由 `config` 或 YAML 维护；5.7 描述的是后续完整初始化页面的目标形态。真实 Orca worker 端到端联调与浏览器驱动落地仍在建设中。

## 5. 配置

### 5.1 位置与合并

| 层级 | 路径 | 是否提交 |
|---|---|---|
| 全局默认 | `$XDG_CONFIG_HOME/orca-team-orchestration/config.yaml`（Windows: `%APPDATA%\orca-team-orchestration\config.yaml`） | 否 |
| 项目 | `<repo>/.orca-team-orchestration/config.yaml` | 是 |
| 运行态 | `<repo>/.orca-team-orchestration/runs/*.json` | 否（.gitignore） |
| 审批 | `<repo>/.orca-team-orchestration/approvals/*.json` | 是（审计） |

合并规则：

- `project`、`runtime`、`agents` 深合并，项目配置优先。
- `roles`、`flow`、`guards`、`checks` **整体替换**：否则项目无法删掉默认角色或默认守则。
- 数组一律整体替换（不拼接），需要增量时用 `+` 前缀的扩展字段。
- 内置默认值最低，其次全局配置，最后项目配置。
- 未知字段直接报错（退出码 3），避免拼写错误静默失效。
- `project.repos` 只认项目配置；全局配置中的同名字段在合并前被剔除，避免机器级默认把所有项目变成 workspace。
- `version` 必须匹配主版本；升级由 `orca-team-orchestration migrate` 处理。

### 5.2 全量 schema

```yaml
version: 1
locale: zh-CN                  # zh-CN | en；决定模板语言

project:
  name: aaa                    # 默认取仓库目录名
  repos:                       # 可选；缺省为单仓
    - name: api                # 唯一、非保留名（workspace/all/root/.）
      path: api                # workspace 相对 POSIX 路径；必须是嵌套独立 Git 仓库
    - name: web
      path: web
  commands:
    start: "cd public && python3 -m http.server 5180 --bind 127.0.0.1"
    test: "node --test"
    build: null                # 可选
    base_url: "http://127.0.0.1:5180/"
  paths:
    features_dir: "features"                # 需求目录：一条 story 一个 <story>.md
    docs: docs                 # 产物根目录
    source: ["public/"]        # 开发角色可写的源码目录
    tests: ["test/"]           # 测试目录
    db: "db/update.sql"        # 数据库迁移文件；无数据库填 null
    evidence: "docs/v{{version}}/test/evidence"   # 测试证据目录

runtime:
  orchestrator: orca           # 默认 orca；auto 也必须检测到 Orca
  shell: auto                  # auto | sh | pwsh | cmd
  timeout_minutes: 60          # 单个 Dispatch 超时
  max_rounds:
    design_review: 3           # 设计 ⇄ 审核，1–10
    dev_test: 3                # 开发 ⇄ 测试，1–10
                               # 超限一律转 gate 交需求方裁决，不可配置为自动继续
  checkpoint_commits: true     # 阶段之间做本地提交
  push: false                  # 固定 false，不接受配置为 true
  worktree: "path:."           # 仅 orca：worker 的工作区选择器

agents:                        # 任意命名、任意数量
  claude-main:
    kind: claude               # claude | codex | zcode | opencode | qoder | codebuddy
    model: claude-sonnet-4-5   # 可空；空则用 agent 自己的默认
    effort: medium             # low | medium | high | null（仅 orca 且模型支持时生效）
    args: []
  codex-review:
    kind: codex
    model: gpt-5-codex

roles:                         # 角色数量、名称由这里决定
  designer:
    agent: claude-main
    writes: ["docs/v{{version}}/design/"]
    artifact:
      path: "docs/v{{version}}/design/{{story}}-r{{round}}.md"
      template: designer       # 内置模板名，或项目内文件路径
      required_sections: ["目标", "验收映射", "数据库变更", "失败路径", "回滚"]
    rules: ""                  # 追加到角色契约之后的小段约束；整段替换契约用 .orca-team-orchestration/roles/<role>.md
  reviewer:
    agent: codex-review
    writes: ["docs/v{{version}}/review/"]
    readonly_source: true      # 除 writes 外不得有工作区改动
    artifact:
      path: "docs/v{{version}}/review/{{story}}-r{{round}}.md"
      template: reviewer
      required_sections: ["问题清单", "通过条件"]
      first_line: ["PASS", "REJECT"]
  developer:
    agent: claude-main
    writes: ["docs/v{{version}}/dev/"]
    artifact:
      path: "docs/v{{version}}/dev/{{story}}-r{{round}}.md"
      template: developer
      required_sections: ["变更", "自测", "SQL"]
    run_checks: ["project-test", "guards"]
  tester:
    agent: codex-review
    writes: ["docs/v{{version}}/test/"]
    artifact:
      path: "docs/v{{version}}/test/{{story}}-r{{round}}.md"
      template: tester
      required_sections: ["用例结果", "证据"]
      first_line: ["PASS", "FAIL"]
    browser:
      driver: orca             # orca | playwright | mcp | none
      url: "{{project.commands.base_url}}"

flow:                          # v1 固定阶段，引用角色名；数组表示“全部通过才算通过”
  design: designer
  review: [reviewer]
  develop: developer
  test: [tester]
  accept: coordinator          # 需求方验收，由协调者记录

guards:
  - id: sql-append-only
    type: append-only          # append-only | immutable | no-delete
    paths: ["db/update.sql"]
    require_header: "-- migration:"
    message: "SQL 只能追加到文件末尾，且每段以 -- migration: 开头"
  - id: config-immutable
    type: immutable
    paths: [".orca-team-orchestration/config.yaml", "package.json", "package-lock.json"]
    allow_new: false
    message: "配置文件改动需要协调者审批"
  - id: no-delete-schema
    type: no-delete
    paths: ["db/**"]
    message: "禁止删除数据库相关文件或语句"

checks:                        # 命名的命令检查，供 run_checks 引用
  project-test:
    command: "{{project.commands.test}}"
    timeout_minutes: 15
    required: true
```

### 5.3 变量

渲染时可用：

| 变量 | 值 |
|---|---|
| `{{story}}` | story id |
| `{{round}}` | 当前阶段轮次（从 1 开始） |
| `{{version}}` | story id 中的版本段（`story-0.1.0-001` → `0.1.0`），用于 `docs/v{{version}}/` 产物目录 |
| `{{stage}}` | design / review / develop / test |
| `{{repo}}` | 仓库绝对路径；多仓下始终是 Workspace 根 |
| `{{workspace}}` | 同 `{{repo}}`，语义更明确 |
| `{{repos}}` | 关联仓库 JSON 数组（`[{name,path}]`）；单仓为空数组 |
| `{{project.*}}` | 项目配置节点，如 `{{project.commands.test}}` |
| `{{paths.*}}` | 路径配置 |
| `{{artifact.path}}` | 当前角色的产物路径 |
| `{{prev_report}}` | 回退时的上一轮报告路径 |

### 5.4 校验

- 必填：`version`；`project.commands.start/test/base_url` 均可为空，为空时由角色在运行时自行识别并交接。
- 角色引用的 `agent` 必须存在于 `agents`。
- `flow` 的五个键必须齐全；值为 `null` 表示跳过该阶段（仅 `review`/`test` 允许跳过）。
- `writes` 必须是非空 glob；禁止 `**` 或仓库根这种过宽范围（防误配）。
- `history` 中所有路径禁止包含 `..`。
- `project.repos`：数组非空；`name` 唯一（大小写不敏感）、非保留名、不能仅大小写不同；`path` 为安全的 workspace 相对 POSIX 路径（无绝对路径、`..`/`.` 段、反斜杠、glob 元字符、尾随点或空格），各段避开 Windows 保留名；仓库之间及与根不能路径重叠。
- 配置了 `project.repos` 时，`runtime.worktree` 只能是 `path:.` 或缺省。

### 5.5 story 文件格式

一条 story 对应一个文件 `features/<story>.md`，文件名（去掉 `.md`）即 story id。
story id 格式固定为 `story-<版本>-<序号>`：前缀必须是 `story`，版本为三段数字（`X.Y.Z`），
序号为一位以上数字，如 `story-0.1.0-001`、`story-1.1.1-02`。
`{{version}}` 即从该版本段派生，docs 产物按 `docs/v<版本>/<阶段>/` 分层。
一个 story 可以包含多个功能，`start` 时**整个文件全部开发**，不做逐功能挑选。

```markdown
# story-0.1.0-001 午餐抽签

- 背景: 中午不知道吃什么，点一下随机抽。
- 明确不做: 除 HTML/CSS/JS 之外的任何东西

## 功能清单

- F1 随机抽签：点击按钮从候选里随机选一个
- F2 展示结果：显示菜名，并提供"再抽一次"
- F3 移动端可用：320px 宽不出现横向滚动

## 验收标准

- [ ] story-0.1.0-001-1 打开页面能看到抽签按钮
- [ ] story-0.1.0-001-2 点击后显示一个菜名
- [ ] story-0.1.0-001-3 320px 宽下无横向滚动
```

解析规则：

- 标题：第一行 `# <story> <标题>`，story 必须与文件名一致，标题必填。
- `## 功能清单`：必填，至少一条；每行 `- <功能 ID> <描述>`，
  功能 ID 在文件内唯一（`F1`、`F2`…，也可用其他短标识）。
- `## 验收标准`：必填，至少一条；列表项 `- [ ] <story>-<序号> <描述>` 或表格行（第一、二列），
  验收 ID 全局唯一，前缀必须是本 story id。
- 可选字段：`背景:`、`依赖:`、`明确不做:`、`测试数据:`、`详见:`。
- `详见:` 指向的长文档作为设计角色的附加输入；不参与验收计数。
- 验收文本是唯一权威；功能清单是设计拆解与测试覆盖的对照表，两者不一致时审核必须 `REJECT`。
  设计要求「验收映射」逐条列出每个功能 → 验收项；测试报告「用例结果」需覆盖每个功能，
  漏功能视为未完成。
- **状态不写回文件**：`orca-team-orchestration list` 的状态由 `.orca-team-orchestration/runs/` 派生，工具不改写用户手写的 Markdown。
- `orca-team-orchestration lint [<story>]` 校验格式并给出出错行号；解析失败时 `start` 以退出码 3 结束。

### 5.6 选择与快照

- `orca-team-orchestration start <story>` 直接执行该 story 文件里的所有功能；不带参数时列出候选文件（进行中的标注出来）等待选择。
- `orca-team-orchestration new <story> [--title "..."]` 创建 `features/<story>.md` 骨架（标题 + 空的功能清单/验收标准）并提交；
  已存在则拒绝覆盖。
- 开始执行时把整个文件快照到 `.orca-team-orchestration/runs/<story>/spec.md`，sha256 写入运行状态；
  所有角色的 prompt 只读快照，不读实时文件。
- 执行中需求文件被改动：`status` / `check` 提示 hash 不一致；`resume --refresh-spec` 重新快照，
  验收文本有变化则回到 DESIGN 阶段重新审核。
- 依赖：`依赖: story-0.1.0-000` 且该 story 未验收时拒绝开始，`--ignore-deps` 可强制。
- v1 一次只跑一条 story，该 story 的全部功能一起交付。

### 5.7 初始化页面（`orca-team-orchestration init --ui`）

配置有两种等价入口：**直接改 YAML**，或用页面点选。YAML 始终是唯一事实来源，页面只是编辑器。

- 触发：`orca-team-orchestration init`（终端且未加 `--no-ui`）自动打开；`orca-team-orchestration config --ui` 重新打开。
- 形态：`node:http` 起本地服务，只监听 `127.0.0.1` 的随机端口，URL 带一次性 token；
  浏览器自动打开，保存后服务退出。页面资源随包分发，离线可用，无 CDN、无构建、无第三方依赖。
- 五步表单：

| 步骤 | 内容 | 预填来源 |
|---|---|---|
| 1. 项目 | 名称、启动/测试命令、base_url、源码目录、数据库文件、证据目录 | 探测 + 现有配置；缺失时角色运行时自行识别 |
| 2. 角色 | 增删角色卡：名称、所属阶段、agent 工具、模型、effort、可写目录、产物路径/必填章节/首行判定、只读源码 | 内置四角色 |
| 3. 轮次 | `design_review` / `dev_test` 上限（1–10）；超限一律转 gate | 3 / 3 |
| 4. 规则 | 每个角色的提示词 Markdown 编辑器 + 数据库等守则开关 | 内置默认提示词 |
| 5. 保存 | 实时 YAML 预览、校验结果、可选提交 | — |

页面布局（左侧编辑，右侧实时 YAML 预览）：

```
┌ 项目 ───────────────────────┬ 配置预览 ──────────────┐
│ 名称  [aaa              ]   │ version: 1             │
│ 启动  [python3 -m ...   ]   │ project:               │
│ 测试  [node --test      ]   │   commands:            │
├ 角色 ───────────────────────┤     start: "..."       │
│ ▸ designer   [design ▾]     │ roles:                 │
│   claude ▾  sonnet-4-5 ▾    │   designer:            │
│   写 [docs/v{{version}}/design/]         │     agent: claude-main │
│ ▸ reviewer   [review ▾]     │ ...                    │
│ [+ 添加角色]                │                        │
├ 轮次 ───────────────────────┤                        │
│ 设计⇄审核 [3]  开发⇄测试 [3] │                        │
├ 规则与守则 ─────────────────┤                        │
│ [designer][reviewer][dev]…  │                        │
│ ┌ Markdown 编辑器 ────────┐ │                        │
│ │ 你负责产出设计文档…     │ │                        │
│ └─────────────────────────┘ │                        │
│ ☑ SQL 只追加  db/update.sql │                        │
│ ☑ 配置不可改  ☑ 禁止删 db/**│                        │
└────────────── [保存并生成配置] ─────────────────────┘
```

- 角色：阶段固定为 design / review / develop / test / accept；review、test 可挂多个角色，
  其余各一个。**增删角色 = 增删角色卡**，不需要改代码。
- agent 与模型：工具下拉（claude / codex / zcode / opencode / qoder / codebuddy），
  模型是可编辑下拉（内置常用预设，也可自由填写）。模型是否真的可用由 `doctor` 和首次派发暴露，
  不做硬编码白名单。
- 轮次：任一阶段超过上限即创建 gate，**不可关闭**；gate 只能由需求方选择
  接受现状 / 再给一轮 / 改需求 / 终止，工具不自动续跑。
- 规则与默认提示词：
  - 每个角色的提示词来自内置默认（`templates/<locale>/`），页面里可改；只把**与默认不同的部分**
    写到 `.orca-team-orchestration/roles/<role>.md` 并在配置里引用，未改则继续用内置默认。
  - 产物模板同理，改过的写到 `.orca-team-orchestration/templates/<role>.md`，`artifact.template` 指向项目文件。
  - 页面提供“查看默认 / 恢复默认”，恢复即删除覆盖文件。
  - 预设守则开关：`SQL 只追加`（选 update.sql 路径、可要求追加段以 `-- migration:` 开头）、
    `配置文件不可改`、`禁止删除 db/**`；高级模式可直接编辑守则 YAML。
- 校验（不合格不允许保存）：角色名唯一；`agent` 引用存在；`writes` 非空且落在仓库内；
  产物路径含 `{{story}}`/`{{round}}`/`{{version}}` 且无 `..`；阶段非空时至少一个角色；`max_rounds` ≥ 1；
  守则路径在仓库内。
- 写入：先写临时文件再原子替换；覆盖前备份为 `.orca-team-orchestration/config.yaml.bak`；只写项目配置，
  全局配置需显式 `--global`。保存后可顺手提交 `chore: orca-team-orchestration init`。
- 安全：仅回环地址；每次请求校验 token；拒绝路径穿越；请求体上限 1 MB；不执行用户输入、不联网、
  不上传；服务在保存或 30 分钟无操作后退出。

### 5.8 多仓 workspace

根仓隐式命名为 `workspace`，并始终位于 `WorkspaceLayout.all[0]`；`project.repos` 中登记的仓库依次排在其后。所有对外路径仍是 workspace 相对路径：

```ts
interface RepoRef { name: string; path: string; root: string }   // root 为绝对路径
interface WorkspaceLayout { root: string; repos: RepoRef[]; all: RepoRef[] }
```

校验分两层：

1. 配置层（`validateConfig`）只做纯结构校验，便于 UI 与配置单测在没有真实仓库时运行。
2. 文件系统层（`validateWorkspace`）在 `start`/`resume`/`check`/`accept`/`guard`/`doctor` 与 `init --workspace` 时执行：
   - workspace 根必须是 Git 顶层，且不能位于另一个仓库内部（realpath 比较）；
   - 每个 repo：目录存在、不是符号链接、realpath 不越界、`.git` 必须是目录（v1 拒绝 worktree/submodule 的 `.git` 文件）、`git rev-parse --show-toplevel` 等于该目录；
   - 子仓不能被根仓跟踪（`git ls-files --error-unmatch` 必须失败），否则报错并提示 `git rm -r --cached <path>`；
   - Windows 下路径比较做大小写归一化。

`init --workspace` 流程：

1. 检查 Orca；
2. `--repos` 优先，否则扫描一级子目录中含 `.git` 的目录（跳过隐藏目录、`node_modules`、`dist`）；
3. 只校验不写文件；根不在 Git 顶层且位于其他仓库内则报错；
4. 根不是 Git 仓库时 `git init -q`；
5. 生成 `project.repos`、`runtime.worktree: path:.`，按子仓检测结果合成 `commands.test/build`（` && ` 连接）、`paths.source/tests/db` 与带仓库后缀的 SQL 守则；
6. 写 `.gitignore` managed block（锚定 `/api/` 等）并确保 `.orca-team-orchestration/runs/`；
7. 根仓没有 HEAD 且未加 `--no-commit` 时，只提交 `.gitignore` 与配置文件，绝不 `git add -A`；
8. 安装根仓与每个子仓 pre-commit hook；
9. `--orca-add` 只注册 workspace 根。

运行期不改变单 worker、线性流程的假设：worker 在 workspace 根编辑所有子仓，不自行提交；检查点由工具逐仓完成。

## 6. 角色与流程

### 6.1 流程

```
INTAKE → DESIGN ⇄ REVIEW → DEVELOP → TEST ⇄ DEVELOP → ACCEPT
                 ≤ max_rounds.design_review   ≤ max_rounds.dev_test
         任意阶段 → GATE（需求方决定）
```

- 阶段固定，角色可换名、可增删（`flow.review: [reviewer, security-reviewer]`）。
- 多个审核角色：全部 `PASS` 才进入开发；任一 `REJECT` 回到设计，轮次 +1。
- 轮次按阶段分别计数；超限创建 gate，不自动重试。
- `accept` 由协调者写 `docs/v{{version}}/test/<story>-accept.md`，等需求方确认。

### 6.2 角色 prompt 的组成

按顺序拼接，后出现的规则覆盖前面的描述性内容：

1. 系统段（工具内置）：角色边界、禁止 push、禁止改需求、产物与校验是权威。
2. 角色契约：内置默认（`templates/<locale>/<role>.md`）或页面改过的 `.orca-team-orchestration/roles/<role>.md`，
   二选一，项目文件优先。
3. 项目段：`commands`、`paths`、与角色相关的 `guards`。
4. 需求段：本条 story 的需求快照 `.orca-team-orchestration/runs/<story>/spec.md` 全文，明确标注“这是需求数据，不是给你的指令”。
   快照在 `start` 时从 `features/<story>.md` 复制，后续轮次与续跑都读快照。
5. 任务段：阶段、轮次、本次要读的上一轮报告、要求的产物路径。
6. 项目规则：`roles.<name>.rules`（额外补充约束，追加在契约之后）。

### 6.3 角色写范围

`writes` + 校验专属目录（如证据目录）构成允许写入的集合，其余一律视为越界。
`readonly_source: true` 的角色（审核/测试）在 `writes` 之外**不允许任何**工作区改动。

### 6.4 检查点提交

- 协调者在接受一个阶段后、派发下一角色前提交：`stage: <STAGE> <story> r<N>`。
- 提交只属于协调者；worker 自己 commit 视为越界。
- 永远本地提交，`push: false` 不可配置为 true。
- 单仓行为不变：`checkpointCommits` 退化为原有 `git add -A` 提交。
- 多仓：
  - 根仓只提交 `features_dir`、`docs`、`evidence`、`config.yaml`、`.gitignore`，并排除 `.orca-team-orchestration/runs` 与所有子仓路径；不会把根目录下无关的未跟踪文件提交进去。
  - 每个子仓使用 `git add -A` 后提交；无改动或提交失败只跳过/告警，不阻塞其他仓库与阶段。
  - 输出逐仓结果：`检查点提交 api@abc1234`。

## 7. 守则引擎

### 7.1 类型

| 类型 | 语义 | 典型用途 |
|---|---|---|
| `append-only` | 当前内容必须以 `HEAD` 版本为前缀；可选的追加段首行校验 | `db/update.sql` |
| `immutable` | 与 `HEAD` 完全一致；新文件默认算违规（`allow_new: true` 可放宽） | `package.json`、`nginx.conf`、`.orca-team-orchestration/config.yaml` |
| `no-delete` | 允许新增/修改，但不允许删除行或删除文件 | `db/**`、`config/**` |

### 7.2 算法

- 基准：阶段校验用工作区 vs `HEAD`；pre-commit 用暂存区 vs `HEAD`。
- `append-only`：读取 `git show HEAD:<path>`（不存在视为空），两侧统一 CRLF→LF 后比较前缀。
  配置了 `require_header` 时，追加部分的第一条非空行必须以其开头。
- `immutable`：`git diff --quiet HEAD -- <path>` 且不存在未跟踪的同名文件。
- `no-delete`：`git diff --numstat` 对匹配路径的删除行数必须为 0；删除文件、重命名出匹配范围也算违规。
- 路径匹配：POSIX 分隔符 + `minimatch`（`**` 可用）；Windows 下先把 `\` 归一为 `/`。
- 输出：违规时逐条打印 `guard id / 文件 / 行为 / 修法`，并以退出码 6 结束。
- 多仓：
  - `FileChange` 同时携带 `path`（workspace 相对）与 `repo`/`repoRoot`/`relPath`（仓库内相对）；
  - `collectWorkspaceChanges` 聚合所有仓库，根仓结果中位于子仓路径下的条目被过滤；
  - `append-only` 用 `change.repoRoot` + `change.relPath` 读取对应仓库的 `HEAD` 或索引；
  - 工作区内容仍用 `workspaceRoot + change.path` 读取；
  - `--staged` 默认只查根仓；`--staged-repo <name>` 查指定子仓；`--staged-repo all` 查全部；
  - 重命名（`R`）对 append-only 仍直接视为违规。

### 7.3 执行点

1. `orca-team-orchestration check`：阶段总校验的一部分。
2. `orca-team-orchestration guard run`：手动/CI。
3. pre-commit hook（由 `init` 安装）：`#!/bin/sh` + `exec node <tool> guard run --staged`。
   - Windows 由 Git for Windows 提供 sh，不需要 WSL。
   - 已存在非本项目 hook 时备份为 `pre-commit.bak`。
   - 多仓下根仓 hook 保持 `--staged`（根仓暂存区）；每个子仓 hook 固定 `--repo <workspace>` 并追加 `--staged-repo <name>`，只检查该子仓。

### 7.4 审批

`orca-team-orchestration guard allow <id> --reason "..."` 生成 `.orca-team-orchestration/approvals/<timestamp>-<id>.json`，
记录需求方、原因、基线 commit。审批只对当次基线有效，下一次检查点提交后失效。
审批不改变规则，只让某次违规带审计地通过，并在阶段汇报中标注。

多仓下审批增加可选 `baselines: Record<string, string>`，记录所有仓库 HEAD；`baseline` 继续保存根仓 HEAD 以兼容旧文件。`settleViolations` 按 `violation.repo` 对比对应仓库 HEAD；旧审批没有 `baselines` 时只对根仓违规生效。`guard allow` 输出逐仓基线，`guard approvals` 展示同样信息。

实现状态（0.0.0）：7.3 与 7.4 已落地——`init` 默认安装 pre-commit hook（`--no-hook` 跳过，外部 hook 备份为 `pre-commit.bak`），`guard allow|approvals` 与 `settleViolations` 按 `HEAD` 基线放行，`guard run`/`check`/StageRunner 均消费审批并把已放行违规标为 `APPROVED`；`explain <story>` 输出状态、下一步、原因与建议命令；`doctor` 增加 hook 与审批统计检查项。

## 8. 编排 adapter

### 8.1 接口

```ts
type Outcome = "succeeded" | "failed" | "blocked" | "timeout";

interface DispatchPlan {
  runId: string;
  story: string;
  stage: Stage;
  role: string;
  round: number;
  agent: AgentConfig;      // kind / model / effort / args
  prompt: string;
  worktree: string;
  timeoutMs: number;
}

interface DispatchResult {
  outcome: Outcome;
  summary: string;
  logs: string;            // 日志文件路径
  exitCode: number | null;
  terminalHandle?: string;
}

interface Orchestrator {
  readonly name: "orca";
  readonly caps: {
    parallel: boolean;
    terminalReuse: boolean;
    perDispatchModel: boolean;
    remoteWorkers: boolean;
    liveUi: boolean;
  };
  probe(): Promise<boolean>;
  start(plan: DispatchPlan): Promise<DispatchResult>;
  send(handle: string, message: string): Promise<void>;
  stop(handle: string): Promise<void>;
  dispose(runId: string): Promise<void>;
}
```

校验层不信任 `outcome`：即使 `succeeded`，也要产物、范围、守则三项通过才算阶段通过。

### 8.2 orca adapter

| 动作 | 命令 |
|---|---|
| 探测 | `orca orchestration run-list --json` |
| 建 Run | `orca orchestration run-create --objective "<story> <title>" --json` |
| 派发 | `orca orchestration worker-start --spec ... --worktree <selector> --agent <kind> [--model] [--effort] --task-title ...` |
| 等待 | `orca orchestration check --wait --types worker_done,escalation,question --timeout-ms ... --json` |
| 确认 | `orca orchestration check --ack <delivery_id>` |
| 回复 | `orca orchestration reply --message <id> --text ...` |
| 升级 | `orca orchestration gate-create --task <id> --question ... --options ...` |
| 收尾 | `worker-retain` / `worker-release` |

约束：

- `--model` / `--effort` 不能与 `--terminal` 同用。**续跑复用终端时无法换模型**，文档中明确说明；需要换模型就新建终端。
- Orca 只接受其已知的 TUI agent id 作为 `--agent`（本工具开放 claude / codex / zcode / opencode / qoder / codebuddy；qoder 由 Orca 以 `qodercli` 命令启动）。派发前工具会在本机 PATH 中预检对应命令，缺失时以退出码 5 失败并提示安装或改绑，不会进入 Orca 才报错。
- Orca CLI 版本做最小/推荐版本检查，版本不符只告警不阻断。
- 多仓下 `runtime.worktree` 只允许 `path:.`：branch/worktree 选择器只覆盖单个仓库，无法同时为根仓和多个子仓建立一致工作区。worker 统一运行在 workspace 根，通过相对路径编辑子仓。

### 8.3 选择

`runtime.orchestrator: auto` 时先 `probe()` Orca；未检测到 Orca 时提示安装并终止。新项目默认写入 `orchestrator: orca`，v1 不提供其他编排器回退路径。
`--orchestrator orca` 可用于显式选择，`doctor` 会显示探测结果；`sequential` 不再被接受。

## 9. 状态与续跑

`.orca-team-orchestration/runs/<story>.json`：

```json
{
  "version": 1,
  "story": "story-0.1.0-001",
  "title": "午餐抽签",
  "runId": "…",
  "orchestrator": "orca",
  "startedAt": "2026-10-24T09:00:00Z",
  "spec": {
    "source": "features/story-0.1.0-001.md",
    "snapshot": ".orca-team-orchestration/runs/story-0.1.0-001/spec.md",
    "sha256": "…"
  },
  "features": ["F1", "F2", "F3"],
  "acceptance": ["story-0.1.0-001-1", "story-0.1.0-001-2", "story-0.1.0-001-3"],
  "stages": {
    "design":  { "round": 2, "status": "passed", "artifact": "docs/v0.1.0/design/story-0.1.0-001-r2.md" },
    "review":  { "round": 2, "status": "passed", "artifact": "docs/v0.1.0/review/story-0.1.0-001-r2.md" },
    "develop": { "round": 1, "status": "running" }
  },
  "history": [
    { "stage": "review", "round": 1, "outcome": "reject", "report": "docs/v0.1.0/review/story-0.1.0-001-r1.md" }
  ]
}
```

- 状态文件是**运行状态**，不回写需求文件；`list` 里的“已完成/进行中”一律由 run 状态推导。
- `features` 记录本次交付范围 = 快照里的全部功能，交付时逐项对照。
- `resume` 以**产物 + 状态文件**共同判断，两者冲突时以产物为准并提示。
- `resume` 会比较 `features/<story>.md` 当前的 sha256 与快照记录：不一致时提示 `--refresh-spec` 重新快照，
  拒绝静默换需求。
- 轮次 = 该阶段已有最大 `rN` + 1，不依赖状态文件，防止状态丢失后重复执行。
- Orca 模式下 `runId` 用于 `run-use` 接手。
- 多仓兼容：`PendingDispatch.baseline` 继续是扁平的 workspace 相对路径数组；旧数组本来就是根仓相对路径，在单仓下等价，因此不 bump `version`。
- 需求快照的 `spec.source` 使用 `config.project.paths.features_dir` 生成；旧状态中的 `features/<story>.md` 仍可读取与校验。

## 10. CLI

| 命令 | 作用 |
|---|---|
| `init [--ui\|--no-ui] [--yes] [--force] [--orca-add] [--baseline]` | 先检测 Orca，缺失时提示安装；通过后接入项目：默认打开初始化页面；`--no-ui` 走命令行；写配置、建目录、装 hook；默认不提交，`--baseline` 才提交一次基线 |
| `init --workspace [--repos a,b] [--no-commit] [--force] [--orca-add] [--no-hook]` | 把父目录接入为多仓 Workspace：自动建根仓、发现/校验嵌套仓库、写 `project.repos` 与 managed `.gitignore`、安装根+子仓 hook |
| `config [--ui] [--print] [--global]` | 页面或命令行补全配置；`--print` 只输出合并后的 YAML |
| `list [--all]` | 从 `features/*.md` 列 story：ID、标题、功能数、验收数、状态（未开始/进行中/待验收/已验收）、依赖 |
| `start [<story>] [--orchestrator] [--agent]` | 不给 ID 时交互选择；切快照、建 run、跑该 story 的全部功能直到待验收（已实现：派发 Orca worker 自动推进） |
| `new <story> [--title "…"]` | 创建 `features/<story>.md` 骨架并提交（手写文件同样合法） |
| `lint [<story>]` | 只校验需求文件格式：文件名与 ID 一致、功能非空、验收编号归属、依赖存在 |
| `resume <story> [--refresh-spec]` | 从状态与产物继续；需求文件变更时需显式刷新快照（已实现：续跑 pending/gate、核实派发存活并在已退出时重新派发、刷新快照） |
| `accept <story>` | 全部阶段通过后记录需求方验收并写验收文档（已实现） |
| `check <stage> <story> [--round N]` | 阶段总校验（产物 + 范围 + 守则 + 角色命令检查） |
| `guard run [--id] [--staged] [--staged-repo name\|all]` | 单独跑守则；多仓下选择暂存区检查范围 |
| `status [<story>]` | Run / 阶段 / 轮次 / 最近产物 |
| `explain <story>` | 下一步该做什么、为什么（已实现：状态、阶段轮次、pending/gate、缺失产物、建议命令） |
| `render <role> <story> [--round N] [--stage S] [--previous PATH] [--json]` | 打印渲染后的 prompt（已实现，调试用；不要求命令配置或 Orca） |
| `doctor` | 环境自检：git、Node、编排器、agent、模型、hook、Orca 注册 |
| `migrate [--from ~/.cockpit]` | 迁移旧原型 |

全局 `--repo` 优先；未显式指定时先取当前 Git 顶层，若该顶层没有项目配置，再向上查找 `project.repos` 包含该仓库的 workspace 根。因此在关联仓库内执行命令会自动落到 workspace 根。

退出码：

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 校验不通过（产物/范围/检查命令） |
| 2 | 用法错误 |
| 3 | 配置或需求文件非法 |
| 4 | 编排器不可用 |
| 5 | agent 不可用或未认证 |
| 6 | 守则违规 |
| 7 | 轮次超限，需要 gate |

## 11. 跨平台

| 问题 | 方案 |
|---|---|
| 无 bash | 工具本身全部 Node 实现；git hook 用 `#!/bin/sh` + `node`，Git for Windows 自带 sh |
| 命令差异 | `runtime.shell: auto`；POSIX `sh -c`，Windows 优先 `pwsh -NoProfile -Command`，否则 `cmd /d /s /c` |
| 路径分隔符 | 配置统一写 `/`；运行时用 `path.resolve`，匹配前把 `\` 归一 |
| CRLF | 内容比较统一归一为 LF；模板以 LF 写入；文档建议 `.gitattributes` |
| 浏览器 | `orca`（需 Orca）/ `playwright`（可选 peer 依赖，按需安装）/ `mcp`（browser-use）/ `none` |
| 编码 | 所有读写显式 UTF-8 |

CI 矩阵：`ubuntu-latest` / `macos-latest` / `windows-latest` × Node 20 / 22。
Orca 端到端测试在 `ORCA_E2E=1` 且本机检测到 Orca CLI 时运行；其余环境使用 fake `orca-ide` 做依赖和 CLI 编排测试。

## 12. 目录结构

### 12.1 仓库

```
orca-team-orchestration/
  package.json            # 单包，bin: orca-team-orchestration
  package-lock.json
  tsconfig.json
  README.md               # 用户手册（含本地开发说明）
  DESIGN.md               # 本设计文档
  LICENSE                 # MIT
  .gitignore
  .gitattributes
  .editorconfig
  .github/workflows/ci.yml
  src/
    cli/                  # 命令入口与参数解析
    core/                 # config / story / guards / runner / state / git / workspace
    adapters/orca/        # Orca 编排适配器
    ui/                   # 本地页面 HTTP 服务（静态资源在 public/）
  public/                 # 页面静态资源（HTML / CSS / JS，无构建）
  templates/
    zh-CN/{system,designer,reviewer,developer,tester}.md
    en/{...}
  examples/
    static-site/
    todo-app/
  test/                   # 扁平的 node:test 用例 + helpers.ts（临时仓库构造器）
  docs/                   # 本仓库自托管时的阶段产物
  features/               # 本仓库自托管时的需求文件
```

### 12.2 项目侧（`init` 生成）

```
<repo>/
  .orca-team-orchestration/
    config.yaml           # 提交
    roles/                # 提交：被改过的角色提示词（未改不生成）
    templates/            # 提交：被改过的产物模板（未改不生成）
    runs/                 # 忽略（含每条 story 的 spec.md 快照）
    approvals/            # 提交
  features/               # 需求方维护，一条 story 一个 <story>.md
  docs/v<版本>/{design,review,dev,test}/   # 按需求版本分层，运行时自动创建
  AGENTS.md               # 追加工具指针段
```

多仓 Workspace（`init --workspace`）：

```text
<workspace>/                 # 根仓，隐式名 workspace
  .gitignore                 # managed block: /api/ /web/ runs/
  .orca-team-orchestration/  # 配置、运行态、审批都留在根
  features/
  docs/
  api/                       # 关联仓库，独立 .git 与 pre-commit(--staged-repo api)
  web/                       # 关联仓库，独立 .git 与 pre-commit(--staged-repo web)
```

根仓负责需求、文档、配置与检查点；子仓源码提交分别落在各自仓库。根仓 `.gitignore` 必须保持对子仓与运行目录的忽略，否则 scope/守则会重复计算。

## 13. 安全

- 永不 `push`、部署、删分支；`runtime.push` 固定 false，配置为 true 直接报错。
- hook 只做本地检查，不联网。
- 初始化页面只监听回环、带一次性 token、拒绝路径穿越；不执行用户输入，不上传任何内容。
- 需求/设计文档进入 prompt 时标注为“数据”，机器校验仍是最终权威，降低 prompt 注入影响。
- 守则覆盖配置文件、锁文件、迁移文件；审批需要显式命令并留审计记录。
- `doctor` 检查 agent 是否已认证；不读取、不打印任何密钥。
- 无遥测、无上传。

## 14. 迁移

`orca-team-orchestration migrate`：

1. 读取 `~/.cockpit/cockpit.md`、`roles/*`、`templates/*` 和项目 `.cockpit/project.md`。
2. 生成 `.orca-team-orchestration/config.yaml`：命令、路径、agents、roles、guards 全部落成结构化配置。
3. 若角色契约与内置模板有差异，写入 `.orca-team-orchestration/roles/<role>.md` 并在配置里引用。
4. 保留 `features/`、`docs/`；旧 `.cockpit/` 不删除，打印差异让用户自行处理。
   原来的 `features/<story>.md` 已经是“一文件一 story”，直接沿用；只需补上 `## 功能清单` 段
   （可从原验收标准推导一条，标记为待需求方确认）。
5. 输出迁移报告：哪些项是等价的、哪些需要人工确认。

## 15. 测试策略

- **单元**：配置合并与校验、模板渲染、story 文件解析（多功能、编号冲突、依赖缺失、表格与列表两种写法）、
  三种 guard 的边界（新增/修改/删除/CRLF/重命名）。
- **页面**：对本地服务发 HTTP 请求跑“探测 → 改配置 → 保存 → 重新加载”的往返，
  断言 YAML 与覆盖文件正确、token 缺失被拒、越界路径被拒；不做像素级 UI 测试。
- **fixture**：每个测试用临时 git 仓库，覆盖现有手工验证过的反例：
  越界写文件、改 SQL 中间行、缺章节、首行非法、immutable 配置被改、no-delete 删行。
- **端到端（orca）**：Linux + `ORCA_E2E=1`，验证 worker-start/check/ack 的真实链路。
- **跨平台**：三平台 CI 跑单元 + fixture，并用 fake `orca-ide` 验证依赖检查。
- **多仓矩阵**：
  - config：合法/非法 repos、重名、保留名、路径越界/重叠、worktree 限制、全局 repos 被忽略；
  - workspace：非 Git 根、根在其他仓库内、子仓缺失/非顶层、symlink 越界、被根跟踪、`.git` 文件；
  - guards：子仓改动映射、根仓过滤、子仓重命名、无 HEAD 子仓、`--staged-repo` 选择、根 `db/**` 不误伤 `api/db/**`；
  - hooks/approvals：根+子仓安装与备份、按仓基线失效、旧审批兼容；
  - runner/CLI：多仓检查点输出、越界 scope、`init --workspace` 自动建仓/ignore/初始提交、祖先解析、doctor；
  - UI：`/api/status` 暴露 `workspace` 与 `repos`；
  - Windows 路径大小写、反斜杠拒绝、POSIX ignore 路径与 hook 引号由现有 CI 矩阵覆盖。

## 16. 版本与兼容

- 配置 `version` 主版本不匹配即报错；次版本只增字段。
- 模板与 CLI 同版本发布；`render` 输出带版本号，便于排查。
- 0.x 阶段允许破坏性变更，但必须提供 `migrate`。
- 发布：GitHub Release + npm；后续再评估单文件二进制。

## 17. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | 本文档评审通过 | 你确认 |
| M1 | story 文件解析 + config + guards + CLI 骨架（`list`/`lint`/`start`/`doctor`） | 单测 + fixture 全绿 |
| M2 | 完整 StageRunner + hook；初始化页面（角色/模型/轮次/提示词/守则） | StageRunner 闭环、PromptRenderer、`render`、pre-commit hook、`guard allow` 审批、`explain` 已完成并有测试；完整初始化页面待完成 |
| M2.5 | 多仓 Workspace：`init --workspace`、多仓 scope/guards/检查点/审批/hook、祖先解析与 doctor | 已实现并有 config/workspace/guards/hooks/runner/CLI/UI 测试覆盖 |
| M3 | orca adapter + resume + gate | adapter、`resume`、gate、检查点提交已实现并有 fake-orchestra 测试；Linux 真实链路端到端待联调 |
| M4 | migrate + 模板双语 + 两个示例 + CI 矩阵 | 三平台 CI 绿。示例（static-site/todo-app，含 features 需求与 README，story 由 `test/examples.test.ts` 校验过 lint）、CI 矩阵（`.github/workflows/ci.yml`，三平台 × Node 20/22）、`ORCA_E2E=1` 门控 e2e 骨架已完成；`migrate` 待旧原型格式确认后进行 |
| M5 | 0.1.0 发布 | README/安装/示例可复现 |

## 18. 开放问题（不阻塞 M1）

1. npm 包名 `orca-team-orchestration` 是否可用，是否需要 scope。
2. `playwright` 作为 optional peer 还是让用户全局安装。
3. 审批粒度：按 guard、按文件、还是按 story。
4. 模板是否需要支持用户完全自定义 `system` 段。
6. 一个 story 含多个功能时，是否允许只验收其中一部分（按验收 ID 勾选）？
   v1 默认整条 story 一起验收；目前按“全部功能一起交付”处理。
7. 是否需要一份只读汇总（如 `.orca-team-orchestration/status.md`）方便不开终端的人看？
   倾向不加，避免与 `features/` 双写。
8. 初始化页面里的模型下拉，是否要在 `doctor` 之外主动调用各 agent CLI 拉取可用模型？
   倾向只给静态预设 + 自由填写，避免各工具参数差异带来的维护成本。

## 19. 许可

MIT。
