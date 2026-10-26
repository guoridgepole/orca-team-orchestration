# 示例：static-site（午餐抽签）

一个零依赖的纯静态页面示例，演示最小配置下的完整阶段闭环：design → review → develop → test → accept。

## 内容

```
static-site/
  .orca-team-orchestration/config.yaml   # 已写好的项目配置
  features/story-0.1.0-001.md                  # 需求源文件（可直接通过 lint）
  public/index.html                      # 抽签页面
```

配置要点：

- `project.commands.start` 用 `python3 -m http.server` 提供本地预览，`base_url` 供 tester 浏览器检查；
- `project.paths.source = [public/]`，develop 阶段的越界判定只看这里；
- `guards: []`，本示例不启用守则，先看主流程。

## 体验流程

在示例目录内直接运行 CLI（无需先 `git init` 时用 `--repo` 指向它）：

```bash
cd examples/static-site
git init && git add -A && git commit -m "feat: 示例基线"

node ../../dist/src/cli/index.js lint                 # 校验需求文件格式
node ../../dist/src/cli/index.js init --baseline      # 目录已配置时只补基线提交
node ../../dist/src/cli/index.js start story-0.1.0-001 --orchestrator orca --dry-run
```

`--dry-run` 会展示分派计划与产物路径而不启动真实 agent。真实联调（需要 Orca 运行）：

```bash
node ../../dist/src/cli/index.js start story-0.1.0-001
node ../../dist/src/cli/index.js explain story-0.1.0-001    # 查看下一步
node ../../dist/src/cli/index.js resume story-0.1.0-001     # 继续等待 worker 结果
node ../../dist/src/cli/index.js accept story-0.1.0-001     # 全部阶段通过后验收
```

## 说明

- `.orca-team-orchestration/runs/` 是运行状态，不应提交；
- worker 若改动 `public/` 之外的文件，范围校验会报 `SCOPE FAIL`；
- 退出码 `4` 表示等待超时（可 `resume` 接续），`7` 表示出现待处理 gate。
