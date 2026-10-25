# 示例：todo-app（待办清单）

带守则（guards）与命令检查（checks）的 Node 示例，演示：

- `sql-append-only` / `no-delete-schema` / `config-immutable` 三条守则如何拦截 worker；
- `guard allow` 审批放行与基线过期；
- developer 角色 `run_checks: [project-test]` 如何跑 `npm test`；
- pre-commit hook（`orca-team-orchestration init` 默认安装）。

## 内容

```
todo-app/
  .orca-team-orchestration/config.yaml   # 含 guards 与 checks 的配置
  features/story-002.md                  # 需求源文件（含依赖关系与 4 条验收）
  package.json                           # dev/test/build 脚本（被 config-immutable 守护）
  src/store.js src/server.js             # 最小实现
  test/todo.test.js                      # node --test
  db/update.sql                          # 追加式迁移（被 sql-append-only 守护）
```

## 体验流程

```bash
cd examples/todo-app
git init && git add -A && git commit -m "feat: 示例基线"

node ../../dist/src/cli/index.js lint
node ../../dist/src/cli/index.js init --baseline      # 同时安装 pre-commit hook
node ../../dist/src/cli/index.js doctor               # 查看 hook / 守则 / agent 状态
```

模拟一次守则违规：改动 `db/update.sql`（重写而非追加）或删掉一行，然后尝试提交：

```bash
# 把文件整体重写，触发 sql-append-only 与 no-delete-schema
git add -A && git commit -m "chore: 改表结构"        # 会被 hook 拦截（退出码 6）

node ../../dist/src/cli/index.js guard run            # 查看违规明细
node ../../dist/src/cli/index.js guard allow sql-append-only --reason "结构调整已评审"
node ../../dist/src/cli/index.js guard allow no-delete-schema --reason "同上"
git commit -m "chore: 改表结构"                       # 审批后放行（基线为当前 HEAD）
```

审批只对签发时的 HEAD 有效：下一次提交后旧审批自动过期，再犯同类违规会重新拦截。

命令检查（不启动真实 agent，单跑校验）：

```bash
node ../../dist/src/cli/index.js check develop story-002   # 会执行 project-test（npm test）
```

## 说明

- `features/story-002.md` 的 F3 标注了依赖（F1、F2），验收含 `npm test` 通过条件；
- `project.paths.db = db/update.sql`，design 模板要求写明「数据库变更」章节；
- `runtime.push` 固定为 `false`，本 CLI 从不执行 `git push`。
