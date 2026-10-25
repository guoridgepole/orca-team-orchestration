const MAX_PROMPT_BYTES = 64 * 1024;
const AGENT_KINDS = ['claude', 'codex', 'zcode', 'opencode', 'qoder', 'codebuddy'];
const AGENT_EFFORTS = ['low', 'medium', 'high'];
const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const STAGE_LABELS = {
  design: '方案设计',
  review: '方案审核',
  develop: '研发',
  test: '测试',
  accept: '验收',
};

const view = {
  snapshot: null,
  selected: null,
  drafts: new Map(),
  initialDrafts: new Map(),
  rounds: { design_review: 4, dev_test: 4 },
  initialRounds: { design_review: 4, dev_test: 4 },
  agents: new Map(),
  initialAgents: new Map(),
  assignments: new Map(),
  initialAssignments: new Map(),
  editable: false,
  previewValid: false,
  previewSeq: 0,
  previewTimer: null,
  baseWarnings: [],
};

function byId(id) {
  return document.querySelector(`#${id}`);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizePrompt(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
  return normalized === '' ? '' : `${normalized}\n`;
}

function promptBytes(text) {
  return new TextEncoder().encode(text).length;
}

function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? stage;
}

function stagesText(role) {
  if (!role.stages || role.stages.length === 0) return '未进入 flow';
  return role.stages.map(stageLabel).join(' / ');
}

function currentRole() {
  if (!view.snapshot || !Array.isArray(view.snapshot.roles)) return null;
  return view.snapshot.roles.find((role) => role.name === view.selected) ?? null;
}

function roleBadge(role) {
  if (!role.stages || role.stages.length === 0) return { label: '未使用', variant: 'muted' };
  const draft = view.drafts.get(role.name) ?? role.defaultPrompt;
  if (normalizePrompt(draft) === normalizePrompt(role.defaultPrompt)) {
    return { label: '继承默认', variant: '' };
  }
  return { label: role.overrideRevision ? '已覆盖' : '已修改', variant: 'ok' };
}

function setCheck(icon, label, ok) {
  icon.textContent = ok ? '✓' : '!';
  icon.classList.toggle('ok', ok);
  icon.classList.toggle('fail', !ok);
  label.textContent = ok ? '可用' : '需要处理';
}

function configureLink(node, value) {
  if (!value) {
    node.removeAttribute('href');
    node.textContent = '未配置';
    return;
  }
  node.href = value;
  node.textContent = value;
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('visible'), 2400);
}

function setRolesState(label, ok) {
  const tag = byId('roles-state');
  tag.textContent = label;
  tag.classList.toggle('ok', ok === true);
  tag.classList.toggle('fail', ok === false);
}

function showError(message) {
  byId('roles-error').textContent = message || '';
}

function setServerStatus(text, online) {
  const badge = byId('server-status');
  badge.textContent = '';
  const dot = element('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  badge.append(dot, text);
  badge.classList.toggle('online', online);
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();

    setServerStatus('本地服务运行中', true);
    byId('server-check').textContent = '响应正常';
    byId('project-name').textContent = status.projectName;
    byId('project-root').textContent = status.projectRoot;
    byId('start-command').textContent = status.startCommand || '未配置';
    byId('test-command').textContent = status.testCommand || '未配置';
    configureLink(byId('base-url'), status.baseUrl);

    const configOk = status.configFound && status.configValid;
    const tag = byId('config-tag');
    tag.textContent = status.configFound ? (configOk ? '配置已加载' : '配置需修复') : '尚未初始化';
    tag.classList.toggle('ok', configOk);
    tag.classList.toggle('fail', !configOk);
    setCheck(byId('config-icon'), byId('config-check'), configOk);
    setCheck(byId('orca-icon'), byId('orca-check'), status.orcaInstalled);
    byId('orca-check').textContent = status.orcaInstalled
      ? `已安装 · ${status.orcaPath}`
      : '未安装，请先安装 Orca';
  } catch {
    setServerStatus('本地服务异常', false);
    byId('project-name').textContent = '无法读取项目状态';
  }
}

function renderTabs() {
  const container = byId('role-tabs');
  container.textContent = '';
  const roles = view.snapshot?.roles ?? [];
  if (roles.length === 0) {
    container.append(element('p', 'hint', '没有可编辑的角色。'));
    return;
  }
  for (const role of roles) {
    const button = element('button', 'role-tab');
    button.type = 'button';
    button.dataset.role = role.name;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', role.name === view.selected ? 'true' : 'false');

    const text = element('span', 'role-tab-text');
    text.append(element('strong', '', role.name), element('small', '', stagesText(role)));

    const badge = roleBadge(role);
    const label = element('span', 'role-badge', badge.label);
    if (badge.variant) label.classList.add(badge.variant);

    button.append(text, label);
    button.addEventListener('click', () => selectRole(role.name));
    container.append(button);
  }
}

function updateTabBadges() {
  const tabs = byId('role-tabs').querySelectorAll('.role-tab');
  for (const tab of tabs) {
    const role = (view.snapshot?.roles ?? []).find((item) => item.name === tab.dataset.role);
    if (!role) continue;
    const badge = roleBadge(role);
    const label = tab.querySelector('.role-badge');
    if (!label) continue;
    label.textContent = badge.label;
    label.classList.toggle('ok', badge.variant === 'ok');
    label.classList.toggle('muted', badge.variant === 'muted');
  }
}

function addFact(list, term, value, mono) {
  const row = element('div');
  row.append(element('dt', '', term));
  const description = element('dd');
  if (mono) {
    description.append(element('code', '', value || '—'));
  } else {
    description.textContent = value || '—';
  }
  row.append(description);
  list.append(row);
}

function renderFacts(role) {
  const facts = byId('role-facts');
  facts.textContent = '';
  if (!role) return;
  addFact(facts, '阶段', stagesText(role));
  addFact(facts, 'Agent', agentSummary(bindingOf(role.name)));
  addFact(facts, '产物', role.artifactPath, true);
  addFact(facts, '必填章节', (role.requiredSections ?? []).join('、'));
  addFact(facts, '首行判定', (role.firstLine ?? []).join(' / '));
  addFact(facts, '可写范围', (role.writes ?? []).join('、'), true);
  addFact(facts, '只读源码', role.readonlySource ? '是' : '否');
  if (role.browser) {
    addFact(facts, '浏览器', `${role.browser.driver}（${role.browser.url || '基址未配置'}）`);
  }
  addFact(facts, '覆盖文件', role.overridePath, true);
  if (role.rules) addFact(facts, '项目规则', role.rules);
}

function updatePromptCount() {
  const role = currentRole();
  const editor = byId('prompt-editor');
  const draft = role ? view.drafts.get(role.name) ?? '' : '';
  const bytes = promptBytes(draft);
  const count = byId('prompt-count');
  count.textContent = role ? `${bytes} / ${MAX_PROMPT_BYTES} 字节` : '';
  count.classList.toggle('over-limit', bytes > MAX_PROMPT_BYTES);
}

function renderEditor() {
  const role = currentRole();
  const editor = byId('prompt-editor');
  const title = byId('role-title');
  const meta = byId('role-meta');
  const state = byId('role-state');

  if (!role) {
    title.textContent = '没有可编辑的角色';
    meta.textContent = view.snapshot?.error || '先运行 orca-team-orchestration init。';
    state.textContent = '—';
    state.classList.remove('ok', 'fail');
    renderFacts(null);
    renderAgentBind(null);
    editor.value = '';
    editor.disabled = true;
    byId('default-prompt').textContent = '—';
    byId('prompt-restore').disabled = true;
    updatePromptCount();
    return;
  }

  const bound = bindingOf(role.name);
  title.textContent = role.name;
  meta.textContent = `${stagesText(role)} · Agent ${agentSummary(bound)}`;
  const badge = roleBadge(role);
  state.textContent = badge.label;
  state.classList.toggle('ok', badge.variant === 'ok');
  state.classList.toggle('fail', false);

  renderFacts(role);
  renderAgentBind(role);
  editor.value = view.drafts.get(role.name) ?? role.effectivePrompt;
  editor.disabled = !view.editable;
  byId('default-prompt').textContent = role.defaultPrompt;
  const details = byId('default-prompt').parentElement;
  if (details && details.querySelector('summary')) {
    details.querySelector('summary').textContent =
      role.defaultSource === 'builtin' ? '查看内置默认' : '查看通用默认（无内置模板）';
  }
  byId('prompt-restore').disabled = !view.editable;
  updatePromptCount();
}

function renderRounds() {
  byId('round-design-review').value = String(view.rounds.design_review);
  byId('round-dev-test').value = String(view.rounds.dev_test);
  for (const id of ['round-design-review', 'round-dev-test']) {
    byId(id).disabled = !view.editable;
  }
}

function renderAgentBind(role) {
  const select = byId('role-agent');
  select.textContent = '';
  if (!role) {
    select.disabled = true;
    return;
  }
  for (const name of view.agents.keys()) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = agentSummary(name);
    select.append(option);
  }
  select.value = bindingOf(role.name) ?? '';
  select.disabled = !view.editable;
}

function agentRow(name, def, uses) {
  const row = element('div', 'agent-row');
  row.dataset.agent = name;

  const heading = element('div', 'agent-id');
  heading.append(
    element('strong', 'agent-name', name),
    element('small', 'agent-usage', uses > 0 ? `${uses} 个角色使用` : '未使用'),
  );

  const kind = document.createElement('select');
  kind.className = 'agent-kind';
  kind.setAttribute('aria-label', `${name} 的类型`);
  for (const value of AGENT_KINDS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    kind.append(option);
  }
  kind.value = def.kind;
  kind.disabled = !view.editable;
  kind.addEventListener('change', () => {
    def.kind = kind.value;
    renderAgentBind(currentRole());
    schedulePreview();
    updateControls();
  });

  const model = document.createElement('input');
  model.className = 'agent-model';
  model.type = 'text';
  model.placeholder = 'model（可空）';
  model.spellcheck = false;
  model.value = def.model;
  model.disabled = !view.editable;
  model.addEventListener('input', () => {
    def.model = model.value;
    renderAgentBind(currentRole());
    schedulePreview();
    updateControls();
  });

  const effort = document.createElement('select');
  effort.className = 'agent-effort';
  effort.setAttribute('aria-label', `${name} 的推理强度`);
  const defaultEffort = document.createElement('option');
  defaultEffort.value = '';
  defaultEffort.textContent = '默认强度';
  effort.append(defaultEffort);
  for (const value of AGENT_EFFORTS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    effort.append(option);
  }
  effort.value = def.effort;
  effort.disabled = !view.editable;
  effort.addEventListener('change', () => {
    def.effort = effort.value;
    schedulePreview();
    updateControls();
  });

  const remove = document.createElement('button');
  remove.className = 'agent-remove secondary button';
  remove.type = 'button';
  remove.textContent = '删除';
  remove.disabled = !view.editable || uses > 0;
  remove.title = uses > 0 ? '仍有角色绑定该 agent，无法删除' : '从 Agent 池删除';
  remove.addEventListener('click', () => {
    view.agents.delete(name);
    renderAgentsPanel();
    renderEditor();
    schedulePreview();
    updateControls();
  });

  row.append(heading, kind, model, effort, remove);
  return row;
}

function renderAgentsPanel() {
  const list = byId('agents-list');
  list.textContent = '';
  if (view.agents.size === 0) {
    list.append(element('p', 'hint', 'Agent 池为空，至少添加一个 agent。'));
    return;
  }
  const usage = agentUsageCounts();
  for (const [name, def] of view.agents) {
    list.append(agentRow(name, def, usage.get(name) ?? 0));
  }
}

function addAgent() {
  if (!view.editable) return;
  const nameInput = byId('agent-new-name');
  const kindSelect = byId('agent-new-kind');
  const name = nameInput.value.trim();
  if (name === '') {
    showError('请填写新 agent 名称。');
    return;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    showError(`agent 名称不能用作安全标识：${name}`);
    return;
  }
  if (view.agents.has(name)) {
    showError(`agent 已存在：${name}`);
    return;
  }
  const kind = kindSelect.value;
  view.agents.set(name, { kind, model: '', effort: '' });
  nameInput.value = '';
  showError('');
  renderAgentsPanel();
  renderEditor();
  schedulePreview();
  updateControls();
}

function selectRole(name) {
  if (!view.snapshot?.roles?.some((role) => role.name === name)) return;
  view.selected = name;
  renderTabs();
  renderEditor();
  updateControls();
}

function collectRounds() {
  return {
    design_review: Number(byId('round-design-review').value),
    dev_test: Number(byId('round-dev-test').value),
  };
}

function roundsChanged() {
  const current = collectRounds();
  return (
    current.design_review !== view.initialRounds.design_review ||
    current.dev_test !== view.initialRounds.dev_test
  );
}

function agentDef(name) {
  return view.agents.get(name) ?? null;
}

function bindingOf(roleName) {
  const assigned = view.assignments.get(roleName);
  if (assigned !== undefined) return assigned;
  const role = (view.snapshot?.roles ?? []).find((item) => item.name === roleName);
  return role ? role.agent : null;
}

function agentUsageCounts() {
  const counts = new Map();
  for (const role of view.snapshot?.roles ?? []) {
    const name = view.assignments.get(role.name) ?? role.agent;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function agentDefinitionChanged() {
  for (const [name, def] of view.agents) {
    const initial = view.initialAgents.get(name);
    if (!initial) return true;
    if (
      def.kind !== initial.kind ||
      def.model !== initial.model ||
      def.effort !== initial.effort ||
      def.command !== initial.command
    ) {
      return true;
    }
  }
  for (const name of view.initialAgents.keys()) {
    if (!view.agents.has(name)) return true;
  }
  return false;
}

function bindingsChanged() {
  for (const [roleName, agentName] of view.assignments) {
    if ((view.initialAssignments.get(roleName) ?? null) !== agentName) return true;
  }
  return false;
}

function agentSummary(name) {
  const def = agentDef(name);
  if (!def) return name;
  const details = [def.kind, def.model].filter((item) => item !== '' && item !== undefined);
  return `${name}（${details.join(', ')}）`;
}

function isDirty() {
  if (!view.editable) return false;
  if (roundsChanged()) return true;
  if (agentDefinitionChanged()) return true;
  if (bindingsChanged()) return true;
  for (const role of view.snapshot.roles) {
    const draft = view.drafts.get(role.name) ?? '';
    const initial = view.initialDrafts.get(role.name) ?? '';
    if (normalizePrompt(draft) !== normalizePrompt(initial)) return true;
  }
  return false;
}

function validateClient(patch) {
  for (const [label, value] of [
    ['设计 ⇄ 审核', patch.rounds.design_review],
    ['开发 ⇄ 测试', patch.rounds.dev_test],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return `${label}轮次必须是 1–100 的整数。`;
    }
  }
  for (const [name, role] of Object.entries(patch.roles)) {
    if (role.prompt !== undefined && role.prompt !== null && promptBytes(role.prompt) > MAX_PROMPT_BYTES) {
      return `角色 ${name} 的提示词超过 ${MAX_PROMPT_BYTES} 字节。`;
    }
  }
  return '';
}

function buildPatch() {
  const rounds = collectRounds();
  const roles = {};
  for (const role of view.snapshot.roles) {
    const draft = view.drafts.get(role.name) ?? '';
    const initial = view.initialDrafts.get(role.name) ?? '';
    const promptChanged = normalizePrompt(draft) !== normalizePrompt(initial);
    const bound = bindingOf(role.name);
    const bindingChanged = bound !== role.agent;
    if (!promptChanged && !bindingChanged) continue;
    const entry = {};
    if (promptChanged) {
      let target = normalizePrompt(draft);
      if (target === '' || target === normalizePrompt(role.defaultPrompt)) target = null;
      entry.baseRevision = role.overrideRevision;
      entry.prompt = target;
    }
    if (bindingChanged) entry.agent = bound;
    roles[role.name] = entry;
  }
  const agents = {};
  for (const [name, def] of view.agents) {
    const initial = view.initialAgents.get(name);
    if (
      initial &&
      def.kind === initial.kind &&
      def.model === initial.model &&
      def.effort === initial.effort
    ) {
      continue;
    }
    agents[name] = {
      kind: def.kind,
      model: def.model.trim() === '' ? null : def.model.trim(),
      effort: def.effort === '' ? null : def.effort,
    };
  }
  for (const name of view.initialAgents.keys()) {
    if (!view.agents.has(name)) agents[name] = null;
  }
  const patch = { baseConfigRevision: view.snapshot.configRevision, rounds, roles };
  if (Object.keys(agents).length > 0) patch.agents = agents;
  return patch;
}

function planItem(text, className) {
  const item = element('li', className || '', text);
  return item;
}

function showPlan(plan) {
  const list = byId('save-plan');
  list.textContent = '';

  const warnings = [...view.baseWarnings, ...(plan?.warnings ?? [])];
  byId('role-warnings').textContent = warnings.join(' ');

  if (!plan) {
    list.append(planItem('尚未修改；编辑提示词、Agent 或轮次后会显示保存计划。'));
    return;
  }
  if (!plan.changed) {
    list.append(planItem('没有需要写入的修改。'));
    return;
  }
  for (const file of plan.files) {
    if (file.action === 'unchanged') continue;
    if (file.action === 'delete') {
      list.append(
        planItem(
          `删除 ${file.path}${file.backupPath ? `（旧文件备份为 ${file.backupPath}）` : ''}`,
        ),
      );
    } else {
      list.append(
        planItem(
          `写入 ${file.path}（${file.bytes} 字节${
            file.backupPath ? `，旧文件备份为 ${file.backupPath}` : ''
          }）`,
        ),
      );
    }
  }
  if (plan.configChanged) {
    const bits = [];
    if (
      plan.rounds.before.design_review !== plan.rounds.after.design_review ||
      plan.rounds.before.dev_test !== plan.rounds.after.dev_test
    ) {
      bits.push(
        `轮次：设计⇄审核 ${plan.rounds.before.design_review} → ${plan.rounds.after.design_review}，开发⇄测试 ${plan.rounds.before.dev_test} → ${plan.rounds.after.dev_test}`,
      );
    }
    for (const [name, def] of Object.entries(plan.agents?.after ?? {})) {
      const before = plan.agents?.before?.[name];
      if (!before) bits.push(`新增 agent ${name}（${def.kind}）`);
      else if (JSON.stringify(before) !== JSON.stringify(def)) bits.push(`更新 agent ${name}`);
    }
    for (const name of Object.keys(plan.agents?.before ?? {})) {
      if (!(name in (plan.agents?.after ?? {}))) bits.push(`删除 agent ${name}`);
    }
    for (const [roleName, agentName] of Object.entries(plan.assignments?.after ?? {})) {
      const before = plan.assignments?.before?.[roleName];
      if (before !== undefined && before !== agentName) {
        bits.push(`角色 ${roleName}：Agent ${before} → ${agentName}`);
      }
    }
    list.append(planItem(`写入 config.yaml（${bits.join('；')}，备份 config.yaml.bak）`));
  }
}

function updateRevisionLabel() {
  const revision = view.snapshot?.configRevision;
  const locale = view.snapshot?.templatesLocale;
  const fallback = view.snapshot?.localeFallback ? '（已回退）' : '';
  byId('roles-revision').textContent = revision
    ? `rev ${revision.slice(0, 8)}${locale ? ` · ${locale}${fallback}` : ''}`
    : '—';
}

function updateControls() {
  const editable = view.editable;
  const dirty = editable && isDirty();
  const save = byId('roles-save');
  save.disabled = !editable || !dirty || !view.previewValid;
  byId('roles-reset').disabled = !view.snapshot?.initialized;
  byId('prompt-editor').disabled = !editable;
  byId('prompt-restore').disabled = !editable || !currentRole();
  byId('role-agent').disabled = !editable || !currentRole();
  byId('round-design-review').disabled = !editable;
  byId('round-dev-test').disabled = !editable;
  byId('agent-new-name').disabled = !editable;
  byId('agent-new-kind').disabled = !editable;
  byId('agent-add').disabled = !editable;
  for (const tab of byId('role-tabs').querySelectorAll('.role-tab')) {
    tab.disabled = !editable;
  }
}

function applySnapshot(snapshot) {
  view.snapshot = snapshot;
  view.baseWarnings = Array.isArray(snapshot.warnings) ? [...snapshot.warnings] : [];
  view.editable = Boolean(snapshot.initialized && snapshot.valid && Array.isArray(snapshot.roles) && snapshot.roles.length > 0);
  view.previewValid = false;
  view.drafts = new Map();
  view.initialDrafts = new Map();

  view.agents = new Map();
  view.initialAgents = new Map();
  for (const [name, def] of Object.entries(snapshot.agents ?? {})) {
    const entry = {
      kind: def.kind ?? 'claude',
      model: def.model ?? '',
      effort: def.effort ?? '',
    };
    view.agents.set(name, entry);
    view.initialAgents.set(name, { ...entry });
  }

  view.assignments = new Map();
  view.initialAssignments = new Map();
  for (const role of snapshot.roles ?? []) {
    view.assignments.set(role.name, role.agent);
    view.initialAssignments.set(role.name, role.agent);
  }

  for (const role of snapshot.roles ?? []) {
    const prompt = role.effectivePrompt ?? role.defaultPrompt ?? '';
    view.drafts.set(role.name, prompt);
    view.initialDrafts.set(role.name, prompt);
  }

  view.rounds = snapshot.rounds
    ? { design_review: snapshot.rounds.design_review, dev_test: snapshot.rounds.dev_test }
    : { design_review: 4, dev_test: 4 };
  view.initialRounds = { ...view.rounds };

  if (!snapshot.roles?.some((role) => role.name === view.selected)) {
    view.selected = snapshot.roles?.[0]?.name ?? null;
  }

  renderTabs();
  renderRounds();
  renderAgentsPanel();
  renderEditor();
  showPlan(null);
  updateRevisionLabel();

  if (!snapshot.initialized) {
    setRolesState('尚未初始化', false);
    showError(snapshot.error || '先运行 orca-team-orchestration init。');
  } else if (snapshot.errorKind === 'parse') {
    setRolesState('YAML 解析失败', false);
    showError(snapshot.error || 'config.yaml 无法解析。');
  } else if (!snapshot.valid) {
    setRolesState('配置需修复', false);
    showError(snapshot.error || '配置校验失败。');
  } else {
    setRolesState('配置有效', true);
    showError('');
  }
  updateControls();
}

async function refreshPreview() {
  if (!view.editable) return;
  const patch = buildPatch();
  const clientError = validateClient(patch);
  if (clientError) {
    view.previewSeq += 1;
    view.previewValid = false;
    showError(clientError);
    setRolesState('需要修复', false);
    showPlan(null);
    updateControls();
    return;
  }

  const seq = ++view.previewSeq;
  try {
    const response = await fetch('/api/roles/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await response.json().catch(() => null);
    if (seq !== view.previewSeq) return;

    if (!response.ok) {
      view.previewValid = false;
      if (response.status === 409 && payload?.error?.code === 'conflict') {
        setRolesState('需要刷新', false);
        showError('配置或提示词已被其他窗口修改，请点击“重置”后重试。');
      } else if (response.status === 409) {
        setRolesState('配置不可用', false);
        showError(payload?.error?.message ?? '配置当前不可保存。');
      } else {
        setRolesState('需要修复', false);
        showError(payload?.error?.message ?? `预览失败（HTTP ${response.status}）`);
      }
      showPlan(null);
    } else {
      view.previewValid = true;
      showError('');
      showPlan(payload);
      setRolesState('预览已更新', true);
    }
  } catch {
    if (seq !== view.previewSeq) return;
    view.previewValid = false;
    showError('无法连接本地服务。');
    setRolesState('连接异常', false);
    showPlan(null);
  }
  updateControls();
}

function schedulePreview() {
  window.clearTimeout(view.previewTimer);
  view.previewValid = false;
  setRolesState('未保存', null);
  updateControls();
  view.previewTimer = window.setTimeout(refreshPreview, 300);
}

async function loadRoles() {
  window.clearTimeout(view.previewTimer);
  view.previewSeq += 1;
  try {
    const response = await fetch('/api/roles', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    applySnapshot(snapshot);
  } catch {
    view.editable = false;
    view.snapshot = null;
    view.selected = null;
    view.previewValid = false;
    setRolesState('读取失败', false);
    showError('无法读取角色配置，请确认本地服务仍在运行。');
    renderTabs();
    renderEditor();
    updateRevisionLabel();
    updateControls();
  }
}

async function saveRoles() {
  if (!view.editable || !view.previewValid) return;
  const patch = buildPatch();
  const clientError = validateClient(patch);
  if (clientError) {
    showError(clientError);
    setRolesState('需要修复', false);
    return;
  }

  const button = byId('roles-save');
  button.disabled = true;
  view.previewSeq += 1;
  try {
    const response = await fetch('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      view.previewValid = false;
      if (response.status === 409 && payload?.error?.code === 'conflict') {
        setRolesState('需要刷新', false);
        showError('配置或提示词已被其他窗口修改，草稿已保留。请点击“重置”刷新后重试。');
      } else if (response.status === 409) {
        setRolesState('配置不可用', false);
        showError(payload?.error?.message ?? '配置当前不可保存。');
      } else {
        setRolesState('保存失败', false);
        showError(payload?.error?.message ?? `保存失败（HTTP ${response.status}）`);
      }
      updateControls();
      return;
    }

    const plan = payload.plan;
    const backedUp =
      plan.configChanged || plan.files.some((file) => file.backupPath !== null);
    applySnapshot(payload.snapshot);
    setRolesState('已保存', true);
    showToast(
      plan.changed
        ? backedUp
          ? '已保存，旧文件已备份为 .bak'
          : '已保存'
        : '没有需要保存的修改',
    );
    await loadStatus();
  } catch {
    view.previewValid = false;
    setRolesState('保存失败', false);
    showError('无法连接本地服务。');
  }
  updateControls();
}

byId('role-tabs').addEventListener('keydown', (event) => {
  const tabs = [...byId('role-tabs').querySelectorAll('.role-tab')];
  if (tabs.length === 0) return;
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  if (next === null) return;
  event.preventDefault();
  tabs[next].focus();
  selectRole(tabs[next].dataset.role);
});

byId('prompt-editor').addEventListener('input', (event) => {
  if (!view.editable) return;
  const role = currentRole();
  if (!role) return;
  view.drafts.set(role.name, event.target.value);
  updatePromptCount();
  updateTabBadges();
  renderEditorState(role);
  schedulePreview();
});

function renderEditorState(role) {
  const badge = roleBadge(role);
  const state = byId('role-state');
  state.textContent = badge.label;
  state.classList.toggle('ok', badge.variant === 'ok');
}

for (const id of ['round-design-review', 'round-dev-test']) {
  byId(id).addEventListener('input', () => {
    if (!view.editable) return;
    schedulePreview();
  });
}

byId('role-agent').addEventListener('change', (event) => {
  const role = currentRole();
  if (!role || !view.editable) return;
  view.assignments.set(role.name, event.target.value);
  byId('role-meta').textContent = `${stagesText(role)} · Agent ${agentSummary(event.target.value)}`;
  renderFacts(role);
  renderAgentsPanel();
  schedulePreview();
  updateControls();
});

for (const kind of AGENT_KINDS) {
  const option = document.createElement('option');
  option.value = kind;
  option.textContent = kind;
  byId('agent-new-kind').append(option);
}

byId('agent-add').addEventListener('click', addAgent);
byId('agent-new-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addAgent();
  }
});

byId('prompt-restore').addEventListener('click', () => {
  const role = currentRole();
  if (!role || !view.editable) return;
  view.drafts.set(role.name, role.defaultPrompt);
  renderEditor();
  updateTabBadges();
  schedulePreview();
});

byId('roles-reset').addEventListener('click', () => {
  loadRoles();
  loadStatus();
});

byId('roles-save').addEventListener('click', saveRoles);

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const value = button.getAttribute('data-copy');
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast('命令已复制');
    } catch {
      showToast(value);
    }
  });
}

loadStatus();
loadRoles();
