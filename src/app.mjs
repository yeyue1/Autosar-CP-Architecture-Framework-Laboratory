import { BootSimulator } from './engine.mjs';
import { PHASES, MODULES, STEPS, SCENARIOS, TASKS } from './model.mjs';
import { LabPlayer } from './player.mjs';
import { getModuleGuide } from './module-guide.mjs';
import { SYSTEM_LAB_PROFILES, SystemArchitectureSimulator } from './system-lab.mjs';
import { UdsSimulator, UDS_SERVICES, UDS_FLASH_PROFILES, buildFlashRequestPlan, deriveTeachingKey, formatHex } from './uds.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const padded = value => String(value).padStart(2, '0');
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const engine = new BootSimulator();
const player = new LabPlayer(engine);
const uds = new UdsSimulator();
const systemLab = new SystemArchitectureSimulator();
let state = engine.getSnapshot();
let udsState = uds.getSnapshot();
let systemLabState = systemLab.getSnapshot();
const udsGoals = new Set();
let flashPlan = null;
let flashCursor = 0;
let flashRunLog = [];
let selectedModule = null;
let runtimeTab = 'timeline';
let selectedSystemNode = 'cdd-angle';
let systemPlaying = false;
let systemTimer = null;
let activeWorkspace = 'startup';
let logSignature = '';
let inspectorSignature = '';
let noticeTimer;
let lastUpdate = performance.now();
let quizIndex = 0;
const welcomeMarkup = $('inspector-content').innerHTML;
const moduleElements = new Map();
const phaseRanges = new Map(PHASES.map(phase => {
  const ids = STEPS.filter(step => step.phase === phase.id).map(step => step.id);
  return [phase.id, { first: Math.min(...ids), last: Math.max(...ids) }];
}));
const layerNames = {
  app: ['应用层', 'APPLICATION'], rte: ['运行时环境', 'RUNTIME ENVIRONMENT'],
  service: ['服务层', 'SERVICES'], abstraction: ['ECU 抽象层', 'ECU ABSTRACTION'],
  mcal: ['微控制器抽象层', 'MCAL'], hardware: ['微控制器硬件', 'HARDWARE'],
};
const layerOrder = ['app', 'rte', 'service', 'abstraction', 'mcal', 'hardware'];
const moduleRoles = {
  power: '微控制器 · 时钟 / 存储 / 外设', mcu: 'MCU 驱动', port: '端口驱动', dio: '数字 IO',
  adc: 'ADC 驱动', pwm: 'PWM 驱动', gpt: '通用定时器', spi: 'SPI 驱动', candrv: 'CAN 驱动',
  wdg: '看门狗驱动', fls: 'Flash 驱动', canif: 'CAN 接口', cantp: 'CAN 传输协议',
  memif: '存储器接口', fee: 'Flash EEPROM 仿真', iohwab: 'IO 硬件抽象', wdgif: '看门狗接口',
  ecum: 'ECU 状态管理', bswm: 'BSW 模式管理', schm: 'BSW 调度器', os: '操作系统',
  comm: '通信管理', com: '信号处理', pdur: 'PDU 路由', cansm: 'CAN 状态管理', nm: '网络管理',
  dcm: '诊断通信', dem: '故障事件管理', nvm: '非易失存储管理', wdgm: '看门狗管理',
  det: '开发错误检测', rte: 'RTE 运行时环境', sensor: '传感器采集', controller: '控制算法',
  actuator: '执行器输出', logger: '诊断与日志', cdd: '复杂驱动',
};
const moduleOrder = ['sensor', 'controller', 'actuator', 'logger', 'rte', 'ecum', 'bswm', 'schm', 'os', 'comm', 'com', 'pdur', 'cansm', 'nm', 'dcm', 'dem', 'nvm', 'wdgm', 'det', 'cantp', 'canif', 'memif', 'fee', 'iohwab', 'wdgif', 'mcu', 'port', 'dio', 'adc', 'pwm', 'gpt', 'spi', 'candrv', 'wdg', 'fls', 'power'];
const labelMap = {
  OFF: 'OFF', STARTUP_ONE: 'STARTUP I', STARTUP_TWO: 'STARTUP II', RUN: 'RUN',
  STOPPED: 'STOPPED', RUNNING: 'RUNNING', INITIALIZED: 'INITIALIZED', UNINIT: 'UNINIT', PENDING: 'PENDING',
  FULL_COMMUNICATION: 'FULL COM', NO_COMMUNICATION: 'NO COM', BUS_OFF: 'BUS-OFF',
  NVM_REQ_OK: 'NVM_REQ_OK', NVM_REQ_PENDING: 'PENDING', DEFAULTS: 'ROM DEFAULTS',
  ROM_DEFAULT: 'ROM DEFAULTS', NVRAM: 'NVRAM', UNSET: '未读取', READY: 'READY',
  FULL_COM: 'FULL COM', NO_COM: 'NO COM', SILENT_COM: 'SILENT COM',
};

const nvmState = () => typeof state.nvm === 'object' ? state.nvm.state : state.nvm;
const canState = () => typeof state.can === 'object' ? state.can.state : state.can;
const commActual = () => typeof state.comm === 'object' ? state.comm.actual : state.comm;

function moduleMarkup(module) {
  return `<button class="module uninit" data-module="${escape(module.id)}" aria-label="查看 ${escape(module.id)} 模块" title="${escape(module.description)}"><span class="module-status" aria-hidden="true"></span><span class="module-title">${escape(moduleRoles[module.id] ?? module.name)}</span><span class="module-id">${escape(module.id === 'power' ? 'CPU / CLOCK / FLASH / SRAM' : module.name)}</span></button>`;
}

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4600);
}

function buildStaticViews() {
  $('scenario-select').innerHTML = SCENARIOS.map(scenario =>
    `<option value="${escape(scenario.id)}">${escape(scenario.label)}</option>`).join('');
  $('phase-track').innerHTML = PHASES.map(phase =>
    `<button class="phase-card" data-phase="${phase.id}" title="跳转到${escape(phase.title)}"><span class="phase-heading"><span class="phase-number">${padded(phase.id + 1)}</span><span>${escape(phase.title)}</span></span><span class="phase-caption">${escape(phase.subtitle)}</span></button>`).join('');
  $('architecture-layers').innerHTML = layerOrder.map(layer => {
    const [name, caption] = layerNames[layer];
    return `<div class="layer-row layer-${layer}"><div class="layer-heading">${name}<small>${caption}</small></div><div class="module-grid">${MODULES.filter(module => module.layer === layer && module.id !== 'cdd').sort((a, b) => moduleOrder.indexOf(a.id) - moduleOrder.indexOf(b.id)).map(moduleMarkup).join('')}</div></div>`;
  }).join('') + `<div class="cdd-rail">${moduleMarkup(MODULES.find(module => module.id === 'cdd'))}</div>`;
  for (const element of document.querySelectorAll('[data-module]')) moduleElements.set(element.dataset.module, element);
  $('task-legend').innerHTML = TASKS.map(task =>
    `<span class="task-legend-item" style="--task-color:${escape(task.color)}"><i></i>${escape(task.period)}ms</span>`).join('');
  $('uds-service-list').innerHTML = UDS_SERVICES.map(service =>
    `<button class="uds-service-card group-${escape(service.group)}" data-uds-request="${escape(service.sample)}"><span class="uds-service-sid">0x${Number(service.sid).toString(16).toUpperCase().padStart(2, '0')}</span><span><strong>${escape(service.label)}</strong><small>${escape(service.note)}</small></span>${service.group !== 'diagnostic' ? `<em>${escape(service.group)}</em>` : ''}</button>`).join('');
  $('flash-profile-select').innerHTML = UDS_FLASH_PROFILES.map(profile => `<option value="${escape(profile.id)}">${escape(profile.label)}</option>`).join('');
  renderFlashProfileMeta();
  renderQuiz();
}

function renderMetrics() {
  $('virtual-time').textContent = number(state.time).toFixed(3);
  $('step-count').textContent = padded(state.cursor);
  $('ecu-state').textContent = labelMap[state.ecum] ?? state.ecum;
  $('cpu-load').textContent = number(state.cpuLoad).toFixed(1);
  const blocked = state.status === 'blocked';
  $('play-button').disabled = blocked;
  $('play-button').classList.toggle('playing', player.playing);
  $('play-button').setAttribute('aria-label', player.playing ? '暂停仿真' : (state.cursor === 0 ? '开始启动' : '继续仿真'));
  $('play-label').textContent = player.playing ? '暂停仿真' : blocked ? '启动阻塞' : state.cursor === 0 ? '开始启动' : '继续仿真';
  $('play-button').firstElementChild.textContent = player.playing ? 'Ⅱ' : '▶';
  $('previous-button').disabled = state.cursor === 0;
  $('step-button').disabled = blocked;
  $('step-scrubber').value = String(state.cursor);
  $('step-scrubber').setAttribute('aria-valuetext', `${state.cursor} / ${STEPS.length} 步`);
  const current = STEPS[state.cursor - 1];
  $('progress-caption').textContent = blocked ? `启动阻塞 · 步骤 ${state.cursor}`
    : state.status === 'running' ? '启动完成 · 周期任务正在运行'
      : current ? `${padded(state.cursor)} / 42 · ${current.title}` : '准备就绪，等待 ECU 上电';
  for (const card of $('phase-track').children) {
    const id = Number(card.dataset.phase);
    const range = phaseRanges.get(id);
    card.classList.toggle('current', id === state.phase);
    card.classList.toggle('complete', state.cursor >= range.last);
    card.classList.toggle('has-breakpoint', [...player.breakpoints].some(stepId => stepId >= range.first && stepId <= range.last));
    card.setAttribute('aria-current', id === state.phase ? 'step' : 'false');
  }
  const ordered = ['OFF', 'STARTUP_ONE', 'STARTUP_TWO', 'RUN'];
  const currentIndex = ordered.indexOf(state.ecum);
  for (const entry of $('ecu-flow').children) {
    const index = ordered.indexOf(entry.dataset.state);
    entry.classList.toggle('current', index === currentIndex);
    entry.classList.toggle('visited', index < currentIndex);
  }
  const watches = [['BswM 模式', state.bswm], ['OS 内核', state.os], ['RTE 状态', state.rte],
    ['NvM 作业', nvmState()], ['NvM 数据来源', state.nvm?.source ?? '—'],
    ['CAN 控制器', canState()], ['ComM 请求', state.comm?.requested ?? '—'], ['ComM 实际', commActual()]];
  $('watch-list').innerHTML = watches.map(([label, value]) => {
    const raw = String(value ?? '—');
    const color = /BUS.?OFF|ERROR|FAIL|TIMEOUT/i.test(raw) ? 'error' : /PENDING|READ|DEFAULT/i.test(raw) ? 'warning' : /RUN|FULL|OK|STARTED|READY/i.test(raw) ? 'healthy' : '';
    return `<div class="watch-item"><dt>${escape(label)}</dt><dd class="${color}" title="${escape(raw)}">${escape(labelMap[raw] ?? raw)}</dd></div>`;
  }).join('');
  const scenario = SCENARIOS.find(item => item.id === state.scenario);
  const scenarioIndex = SCENARIOS.indexOf(scenario);
  $('experiment-note').classList.toggle('fault', state.scenario !== 'normal');
  $('experiment-note').innerHTML = `<span class="micro-label">EXPERIMENT ${padded(scenarioIndex + 1)}</span><strong>${escape(scenario?.label)}</strong><p>${escape(scenario?.description)}</p>`;
  $('runtime-caption').textContent = state.status === 'running' ? `RUN + ${number(state.runtimeMs).toFixed(0)} ms` : '等待 OS / RTE';
}

function renderArchitecture() {
  const guide = selectedModule ? getModuleGuide(selectedModule) : null;
  const relatedModules = new Set([...(guide?.upstream ?? []), ...(guide?.downstream ?? [])].map(module => module.id));
  for (const [id, element] of moduleElements) {
    const status = state.modules[id] ?? 'uninit';
    const active = state.activeModules.includes(id) && status !== 'error';
    const related = relatedModules.has(id);
    const dimmed = selectedModule && selectedModule !== id && !related;
    element.className = `module ${status}${active ? ' active' : ''}${selectedModule === id ? ' selected' : ''}${related ? ' related' : ''}${dimmed ? ' dimmed' : ''}`;
    element.setAttribute('aria-pressed', String(selectedModule === id));
  }
  const step = STEPS[state.cursor - 1];
  $('architecture-caption').textContent = step ? `${step.caller} → ${step.target}` : '从底层硬件开始，逐层唤醒整套系统。';
  const hasRte = state.rte === 'RUNNING';
  $('sensor-signal').textContent = hasRte ? number(state.signals.sensor).toFixed(1) : '—';
  $('filtered-signal').textContent = hasRte ? number(state.signals.filtered).toFixed(1) : '—';
  $('actuator-signal').textContent = hasRte ? number(state.signals.actuator).toFixed(1) : '—';
  $('heartbeat-label').textContent = hasRte ? `HB ${state.signals.heartbeat}` : '等待 RTE';
  $('heartbeat-dot').classList.toggle('live', hasRte && player.playing);
}

function moduleDisplayName(module) {
  return moduleRoles[module.id] ?? module.name;
}

function moduleStateName(moduleId) {
  const names = { uninit: '未初始化', ready: '已就绪', active: '当前步骤', error: '故障' };
  const raw = state.modules[moduleId] ?? 'uninit';
  return names[raw] ?? raw;
}

function renderModuleGuide() {
  if (!selectedModule) return;
  const guide = getModuleGuide(selectedModule);
  const module = guide.module;
  const layer = layerNames[module.layer] ?? [module.layer, module.layer];
  $('module-dialog-eyebrow').textContent = `${layer[1]} · ${module.id.toUpperCase()} · STARTUP CONTEXT`;
  $('module-dialog-title').textContent = `${moduleDisplayName(module)} · ${module.name}`;
  $('module-dialog-summary').textContent = module.description;

  const peerButton = (peer, relation) => `<button class="module-peer" data-module-peer="${escape(peer.id)}"><span>${escape(relation)}</span><strong>${escape(moduleDisplayName(peer))}</strong><code>${escape(peer.name)}</code></button>`;
  const flows = guide.flows.map(flow => `<article class="module-flow-card"><div><strong>${escape(flow.label)}</strong><p>${escape(flow.description)}</p></div><div class="module-flow-track">${flow.modules.map((id, index) => {
    const item = MODULES.find(candidate => candidate.id === id);
    const node = `<button class="module-flow-node${id === module.id ? ' current' : ''}" data-module-peer="${escape(id)}" aria-current="${id === module.id ? 'true' : 'false'}"><strong>${escape(moduleDisplayName(item))}</strong><code>${escape(item.name)}</code></button>`;
    return `${index ? '<span class="module-flow-arrow" aria-hidden="true">→</span>' : ''}${node}`;
  }).join('')}</div></article>`).join('');
  const steps = guide.steps.map(step => `<button class="module-guide-step${state.cursor === step.id ? ' current' : ''}" data-module-step="${step.id}" data-module-owner="${escape(module.id)}"><span>${padded(step.id)}</span><div><strong>${escape(step.title)}</strong><small>PHASE ${padded(step.phase + 1)} · ${escape(step.phaseInfo.title)} · ${escape(step.role)}</small><code>${escape(step.caller)} → ${escape(step.target)} · ${escape(step.api)}</code></div></button>`).join('');
  const apiList = module.apis?.length ? module.apis : [...new Set(guide.steps.map(step => step.api))];
  const firstStep = guide.firstStep ? `第 ${guide.firstStep.id} 步` : '未单独展开';
  const phaseRange = guide.firstStep ? `${padded(guide.firstStep.phase + 1)}${guide.lastStep && guide.lastStep.phase !== guide.firstStep.phase ? `–${padded(guide.lastStep.phase + 1)}` : ''}` : '—';

  $('module-dialog-body').innerHTML = `<section class="module-guide-stats"><div><span>所在层</span><strong>${escape(layer[0])}</strong></div><div><span>当前状态</span><strong>${escape(moduleStateName(module.id))}</strong></div><div><span>首次参与</span><strong>${escape(firstStep)}</strong></div><div><span>覆盖阶段</span><strong>PHASE ${escape(phaseRange)}</strong></div></section><div class="module-guide-grid"><section class="module-guide-card module-guide-story"><div class="section-label">LIFECYCLE</div><h3>它在启动与运行中做什么？</h3><div class="module-guide-story-row"><span>启动职责</span><p>${escape(guide.startupRole)}</p></div><div class="module-guide-story-row"><span>运行期角色</span><p>${escape(guide.runtimeRole)}</p></div><div class="module-guide-story-row caution"><span>容易误解</span><p>${escape(guide.caution)}</p></div></section><section class="module-guide-card module-guide-apis"><div class="section-label">INTERFACES & NEIGHBORS</div><h3>接口与相邻模块</h3><div class="module-api-cloud">${apiList.map(api => `<code>${escape(api)}</code>`).join('') || '<span>由硬件或项目集成代码驱动</span>'}</div><div class="module-peer-groups"><div><span>上游</span>${guide.upstream.map(peer => peerButton(peer, 'UPSTREAM')).join('') || '<small>没有直接上游</small>'}</div><div><span>下游</span>${guide.downstream.map(peer => peerButton(peer, 'DOWNSTREAM')).join('') || '<small>没有直接下游</small>'}</div></div></section><section class="module-guide-card module-guide-flows"><div class="section-label">SOFTWARE ARCHITECTURE</div><h3>它位于哪些软件路径？</h3>${flows || '<p class="module-guide-empty">当前教学模型未为此模块配置跨层路径。</p>'}</section><section class="module-guide-card module-guide-timeline"><div class="section-label">STARTUP TIMELINE</div><h3>在42步启动流程中的参与点</h3><div class="module-guide-step-list">${steps || '<p class="module-guide-empty">当前教学配置未单独展开此模块的初始化步骤。</p>'}</div></section></div><p class="module-guide-boundary">该视图由当前项目的 MODULES 与 STEPS 自动派生，并补充少量教学提示；它解释本实验配置，不声称代表所有量产 ECU 的唯一架构。</p>`;
  $('module-dialog-body').scrollTop = 0;
}

const systemStateLabels = {
  waiting: '等待', active: '当前执行', ready: '本地就绪', online: '已上线', error: '故障',
  idle: '等待启动', running: '启动中', complete: '全部就绪', degraded: '降级可用', blocked: '安全阻塞',
};

const workspaceConfig = {
  startup: { panel: 'startup-workspace', tab: 'lab-tab-startup', title: '启动流程实验' },
  uds: { panel: 'uds-workspace', tab: 'lab-tab-uds', title: 'UDS 诊断与刷写实验' },
  system: { panel: 'system-workspace', tab: 'lab-tab-system', title: '系统架构实验' },
};

function prepareLabWorkspaces() {
  document.body.dataset.workspace = activeWorkspace;
}

function stopSystemPlayback() {
  clearInterval(systemTimer);
  systemTimer = null;
  systemPlaying = false;
}

function switchWorkspace(workspaceId, systemProfileId = null) {
  if (!workspaceConfig[workspaceId]) throw new Error(`Unknown workspace: ${workspaceId}`);
  if (workspaceId !== 'startup') player.pause();
  if (workspaceId !== 'system') stopSystemPlayback();
  if (workspaceId === 'system' && systemProfileId && systemProfileId !== systemLab.profile.id) {
    systemLab.selectProfile(systemProfileId);
    selectedSystemNode = systemLab.profile.nodes[0].id;
  }
  activeWorkspace = workspaceId;
  document.body.dataset.workspace = workspaceId;
  for (const [id, config] of Object.entries(workspaceConfig)) {
    const selected = id === workspaceId;
    $(config.panel).hidden = !selected;
    $(config.panel).classList.toggle('active', selected);
    $(config.tab).classList.toggle('active', selected);
    $(config.tab).setAttribute('aria-selected', String(selected));
    $(config.tab).tabIndex = selected ? 0 : -1;
  }
  $('lab-current-title').textContent = workspaceConfig[workspaceId].title;
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (workspaceId === 'startup') {
    render();
    requestAnimationFrame(() => { drawFlow(); drawTimeline(); });
  } else if (workspaceId === 'uds') {
    render();
    renderUds();
  } else {
    renderSystemLab();
    $('system-lab-body').scrollTop = 0;
  }
}

function renderSystemLab() {
  systemLabState = systemLab.getSnapshot();
  const profile = systemLab.profile;
  const activeActors = new Set(systemLabState.currentStep?.actors ?? []);
  if (!profile.nodes.some(node => node.id === selectedSystemNode)) selectedSystemNode = profile.nodes[0].id;
  const selectedNode = profile.nodes.find(node => node.id === selectedSystemNode);
  const faultLabel = profile.fault?.label ?? '关键依赖失败';
  const statusText = systemStateLabels[systemLabState.status] ?? systemLabState.status;
  const statusDetail = systemLabState.blockReason || systemLabState.degradedReason || (systemLabState.currentStep?.description ?? '选择一个实验并单步观察依赖如何收敛。');
  const groups = profile.groups.map(group => `<section class="system-lane"><div class="system-lane-heading"><span>${escape(group.label)}</span><code>${escape(group.caption)}</code></div><div class="system-node-grid">${group.nodes.map(id => {
    const node = profile.nodes.find(item => item.id === id);
    const nodeState = systemLabState.nodeStates[id];
    return `<button class="system-node state-${escape(nodeState)}${activeActors.has(id) ? ' actor' : ''}${selectedSystemNode === id ? ' selected' : ''}" data-system-node="${escape(id)}" aria-pressed="${selectedSystemNode === id}"><span class="system-node-status">${escape(systemStateLabels[nodeState] ?? nodeState)}</span><strong>${escape(node.label)}</strong><code>${escape(node.short)}</code><small>${escape(node.owner)}</small></button>`;
  }).join('')}</div></section>`).join('');
  const flows = profile.flows.map(flow => {
    const from = profile.nodes.find(node => node.id === flow.from);
    const to = profile.nodes.find(node => node.id === flow.to);
    return `<div><span>${escape(from.short)}</span><i>→</i><span>${escape(to.short)}</span><code>${escape(flow.label)}</code></div>`;
  }).join('');
  const timeline = profile.steps.map(step => `<button class="system-step${systemLabState.cursor === step.id ? ' current' : ''}${systemLabState.cursor > step.id ? ' done' : ''}" data-system-seek="${step.id}"><span>${padded(step.id)}</span><div><strong>${escape(step.title)}</strong><code>${escape(step.api)}</code><small>${escape(step.description)}</small></div></button>`).join('');
  const references = profile.references.length ? `<div class="system-reference-list">${profile.references.map(reference => `<a href="${escape(reference.url)}" target="_blank" rel="noreferrer">${escape(reference.label)} ↗</a>`).join('')}</div>` : '';

  $('system-lab-body').innerHTML = `
    <section class="system-profile-tabs" role="tablist" aria-label="系统架构实验类型">${SYSTEM_LAB_PROFILES.map(item => `<button role="tab" aria-selected="${item.id === profile.id}" class="${item.id === profile.id ? 'active' : ''}" data-system-profile="${escape(item.id)}"><strong>${escape(item.label)}</strong><small>${escape(item.caption)}</small></button>`).join('')}</section>
    <section class="system-lab-toolbar"><div><span class="section-label">${escape(profile.caption)}</span><h3>${escape(profile.label)}</h3><p>${escape(profile.summary)}</p></div><div class="system-lab-controls"><label><span>实验场景</span><select id="system-scenario"><option value="normal"${systemLabState.scenarioId === 'normal' ? ' selected' : ''}>正常启动</option><option value="fault"${systemLabState.scenarioId === 'fault' ? ' selected' : ''}>故障 · ${escape(faultLabel)}</option></select></label><button class="button" data-system-action="reset">↻ 重置</button><button class="button" data-system-action="step"${['blocked', 'complete', 'degraded'].includes(systemLabState.status) ? ' disabled' : ''}>↦ 单步</button><button class="button primary${systemPlaying ? ' playing' : ''}" data-system-action="play">${systemPlaying ? 'Ⅱ 暂停' : '▶ 播放架构'}</button></div></section>
    <section class="system-lab-stats"><div><span>实验状态</span><strong class="status-${escape(systemLabState.status)}">${escape(statusText)}</strong></div><div><span>启动进度</span><strong>${padded(systemLabState.cursor)} / ${padded(profile.steps.length)}</strong></div><div><span>当前动作</span><strong>${escape(systemLabState.currentStep?.api ?? '等待第一步')}</strong></div><div><span>主线基线</span><strong>单 ECU · 单核 · 42 步</strong></div></section>
    <div class="system-lab-main"><section class="system-card system-topology"><div class="system-card-heading"><div><span class="section-label">INSTANCE TOPOLOGY</span><h3>实例、所有权与状态</h3></div><span class="micro-label">点击节点查看职责</span></div><div class="system-lanes">${groups}</div><div class="system-flow-list">${flows}</div></section><aside class="system-card system-context"><div class="system-card-heading"><div><span class="section-label">CURRENT CONTEXT</span><h3>${escape(systemLabState.currentStep?.title ?? '等待启动')}</h3></div><span class="system-context-state status-${escape(systemLabState.status)}">${escape(statusText)}</span></div><code class="system-current-api">${escape(systemLabState.currentStep?.api ?? '—')}</code><p>${escape(statusDetail)}</p><div class="system-selected-node"><span>${escape(selectedNode.short)} · ${escape(systemStateLabels[systemLabState.nodeStates[selectedNode.id]])}</span><strong>${escape(selectedNode.label)}</strong><small>${escape(selectedNode.owner)}</small><p>${escape(selectedNode.description)}</p></div><div class="system-distinction"><strong>先分清边界</strong><p>${escape(profile.distinction)}</p></div></aside></div>
    <section class="system-card system-timeline"><div class="system-card-heading"><div><span class="section-label">DETERMINISTIC STARTUP</span><h3>可回放启动步骤</h3></div><span class="micro-label">点击任一步骤回放</span></div><div class="system-step-list">${timeline}</div></section>
    <section class="system-concepts">${profile.concepts.map(concept => `<article><span class="section-label">LEARNING POINT</span><h3>${escape(concept.title)}</h3><p>${escape(concept.text)}</p></article>`).join('')}</section>
    <footer class="system-boundary"><span>教学边界：拓扑、时间和故障均为可确定性示例，不代表任一量产 ECU 的唯一配置。</span>${references}</footer>`;
}

function openSystemLab(profileId = systemLab.profile.id) {
  switchWorkspace('system', profileId);
}

function toggleSystemPlayback() {
  if (systemPlaying) {
    stopSystemPlayback();
    renderSystemLab();
    return;
  }
  if (['blocked', 'complete', 'degraded'].includes(systemLab.getSnapshot().status)) systemLab.reset();
  systemPlaying = true;
  renderSystemLab();
  systemTimer = setInterval(() => {
    systemLabState = systemLab.step();
    renderSystemLab();
    if (['blocked', 'complete', 'degraded'].includes(systemLabState.status)) {
      stopSystemPlayback();
      renderSystemLab();
    }
  }, 720);
}

function openModuleGuide(moduleId) {
  player.pause();
  selectedModule = moduleId;
  inspectorSignature = '';
  render();
  renderModuleGuide();
  if (!$('module-dialog').open) $('module-dialog').showModal();
}

function jumpToModuleStep(stepId, moduleId) {
  seek(stepId);
  selectedModule = moduleId;
  inspectorSignature = '';
  render();
  if ($('module-dialog').open) renderModuleGuide();
}

function renderInspector() {
  const signature = `${selectedModule}|${state.cursor}|${state.status}|${state.modules[selectedModule]}|${nvmState()}|${commActual()}`;
  if (signature !== inspectorSignature) {
    inspectorSignature = signature;
    const container = $('inspector-content');
    if (selectedModule) {
      const guide = getModuleGuide(selectedModule);
      const module = guide.module;
      const apis = module.apis?.length ? module.apis : [...new Set(guide.steps.map(step => step.api))].slice(0, 6);
      $('inspector-title').textContent = '模块学习卡';
      $('inspector-index').textContent = module.id.toUpperCase();
      const neighborNames = [...guide.upstream, ...guide.downstream].slice(0, 5).map(item => moduleDisplayName(item));
      container.innerHTML = `<span class="inspector-phase">${escape(module.id === 'cdd' ? 'COMPLEX DRIVERS · 跨层集成' : layerNames[module.layer]?.[1])}</span><h3 class="step-title">${escape(moduleDisplayName(module))} · ${escape(module.name)}</h3><div class="module-summary-badges"><span class="module-state-badge">${escape(moduleStateName(module.id))}</span><span class="module-state-badge">${guide.firstStep ? `首次 · 第 ${guide.firstStep.id} 步` : '未单独展开'}</span></div><p class="step-description">${escape(module.description)}</p><div class="inspector-section-title">启动职责</div><p class="explanation">${escape(guide.startupRole)}</p><div class="inspector-section-title module-section-spaced">关键 API</div><ul class="api-list compact">${apis.slice(0, 5).map(api => `<li>${escape(api)}</li>`).join('') || '<li>由硬件复位或项目集成代码驱动</li>'}</ul><div class="inspector-section-title">架构相邻模块</div><p class="explanation">${neighborNames.length ? escape(neighborNames.join(' · ')) : '当前派生关系中没有直接相邻模块。'}</p><button class="button module-guide-open" data-module-guide="${escape(module.id)}"><span>⌘</span>展开软件架构与启动时间线</button><div class="step-context"><div><span>相关启动步骤</span><code>${guide.steps.length ? guide.steps.map(step => padded(step.id)).join(' · ') : '—'}</code></div><div><span>提示</span><span>点击「跟随执行」返回步骤详解</span></div></div>`;
      if (module.id === 'cdd') container.insertAdjacentHTML('beforeend', '<button class="button module-guide-open cdd-system-open" data-system-lab="cdd"><span>▦</span>进入 CDD 交互实验</button>');
    } else if (state.cursor === 0) {
      $('inspector-title').textContent = '当前步骤详解';
      $('inspector-index').textContent = 'READY';
      container.innerHTML = welcomeMarkup;
    } else {
      const step = STEPS[state.cursor - 1];
      const phase = PHASES.find(item => item.id === step.phase);
      $('inspector-title').textContent = '当前步骤详解';
      $('inspector-index').textContent = `${padded(step.id)} / 42`;
      container.innerHTML = `<div class="inspector-phase">PHASE ${padded(step.phase + 1)} · ${escape(phase.title)}</div><h3 class="step-title">${escape(step.title)}</h3><code class="api-label">${escape(step.api)}</code><p class="step-description">${escape(step.description)}</p><h4 class="inspector-section-title">为什么在此时执行？</h4><p class="explanation">${escape(step.explanation)}</p><pre class="code-block"><code>${escape(step.code || `${step.api};`)}</code></pre><p class="code-note">教学伪代码 · 不能直接编译或烧录</p><div class="step-context"><div><span>调用方</span><code>${escape(step.caller)}</code></div><div><span>目标模块</span><code>${escape(step.target)}</code></div><div><span>步骤参考耗时</span><code>${number(step.duration).toFixed(3)} ms · 非实测</code></div></div>${state.blockReason ? `<div class="blocked-banner"><strong>启动被安全阻塞</strong><br>${escape(state.blockReason)}<br>可回退观察前置状态，或切回正常场景。</div>` : ''}`;
    }
    container.scrollTop = 0;
  }
  const next = state.cursor + 1;
  const breakpointSet = player.breakpoints.has(next);
  $('breakpoint-button').disabled = next > STEPS.length;
  $('breakpoint-button').classList.toggle('set', breakpointSet);
  $('breakpoint-button').setAttribute('aria-pressed', String(breakpointSet));
  $('breakpoint-label').textContent = next > STEPS.length ? '启动步骤已全部完成' : breakpointSet ? `已设置断点 · 第 ${next} 步之前` : `在第 ${next} 步之前设置断点`;
}

function renderLogs() {
  const filter = $('log-filter').value.trim().toLowerCase();
  const signature = `${state.logs.length}|${state.logs.at(-1)?.seq}|${filter}`;
  $('log-count').textContent = String(state.logs.length);
  if (signature === logSignature) return;
  logSignature = signature;
  const logs = state.logs.filter(log => `${log.source} ${log.message} ${log.level}`.toLowerCase().includes(filter));
  const body = $('log-body');
  const scrollTop = body.scrollTop;
  if (!logs.length) {
    body.innerHTML = `<div class="empty-state"><span class="empty-icon">⌁</span><span>${filter ? '没有匹配的事件' : '启动事件将在这里留下足迹'}</span><small>${filter ? '尝试模块名称，或清空筛选条件' : '时间戳使用可确定性回放的虚拟时间'}</small></div>`;
    return;
  }
  body.innerHTML = logs.map(log => `<div class="log-row ${escape(log.level)}"><span class="log-time">${number(log.time).toFixed(3)}</span><span class="log-source">${escape(log.source)}</span><span class="log-message">${escape(log.message)}</span></div>`).join('');
  body.scrollTop = $('autoscroll').checked ? body.scrollHeight : scrollTop;
}

function canvasContext(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
  }
  const context = canvas.getContext('2d');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function drawFlow() {
  const canvas = $('flow-canvas');
  const { context } = canvasContext(canvas);
  if (!state.cursor || state.status === 'running') return;
  const step = STEPS[state.cursor - 1];
  const targets = [...new Set(step.modules)].filter(id => moduleElements.has(id));
  if (targets.length < 2) return;
  const origin = canvas.getBoundingClientRect();
  const centers = targets.map(id => {
    const box = moduleElements.get(id).getBoundingClientRect();
    return { x: box.left - origin.left + box.width / 2, y: box.top - origin.top + box.height / 2 };
  });
  context.strokeStyle = state.status === 'blocked' ? '#c9656380' : '#ba9b5480';
  context.lineWidth = 1.2;
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(centers[0].x, centers[0].y);
  for (const center of centers.slice(1)) context.lineTo(center.x, center.y);
  context.stroke();
  context.setLineDash([]);
  const last = centers.at(-1);
  context.fillStyle = state.status === 'blocked' ? '#c66b70' : '#bc9957';
  context.beginPath();
  context.arc(last.x, last.y, 3, 0, Math.PI * 2);
  context.fill();
}

function drawTimeline() {
  if (runtimeTab !== 'timeline') return;
  const { context, width, height } = canvasContext($('task-canvas'));
  const left = width < 480 ? 71 : 82;
  const right = 13;
  const top = 13;
  const bottom = 24;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const rowHeight = plotHeight / TASKS.length;
  const end = Math.max(120, number(state.time));
  const start = end - 120;
  const x = time => left + (time - start) / 120 * plotWidth;
  context.font = '8px Consolas, monospace';
  context.textBaseline = 'middle';
  context.fillStyle = '#93a3b1';
  context.lineWidth = 1;
  for (let tick = 0; tick <= 6; tick++) {
    const tickX = left + tick / 6 * plotWidth;
    context.strokeStyle = '#eef2f5';
    context.beginPath();
    context.moveTo(tickX, top - 3);
    context.lineTo(tickX, height - bottom + 2);
    context.stroke();
    context.textAlign = tick === 6 ? 'right' : 'left';
    context.fillText(`${Math.round(start + tick * 20)}`, tickX + (tick === 6 ? 0 : 2), height - 10);
  }
  TASKS.forEach((task, index) => {
    const rowY = top + rowHeight * index;
    context.fillStyle = task.color;
    context.fillRect(2, rowY + rowHeight / 2 - 4, 2, 8);
    context.fillStyle = '#899caa';
    context.textAlign = 'left';
    context.fillText(task.name || task.id, 9, rowY + rowHeight / 2);
    context.strokeStyle = '#f1f4f6';
    context.beginPath();
    context.moveTo(left, rowY + rowHeight - 1);
    context.lineTo(width - right, rowY + rowHeight - 1);
    context.stroke();
    context.fillStyle = task.color;
    for (const event of state.taskEvents) {
      if (event.task !== task.id && event.task !== task.name) continue;
      const eventStart = number(event.start);
      const eventEnd = eventStart + number(event.duration);
      if (eventEnd < start || eventStart > end) continue;
      const from = Math.max(left, x(eventStart));
      const to = Math.min(width - right, x(eventEnd));
      context.globalAlpha = .8;
      context.fillRect(from, rowY + Math.max(2, rowHeight * .24), Math.max(1.2, to - from), Math.max(4, rowHeight * .52));
    }
    context.globalAlpha = 1;
  });
  $('timeline-empty').hidden = state.taskEvents.length > 0;
}

function renderCan() {
  $('frame-count').textContent = String(state.frames.length);
  $('can-status-label').textContent = `CAN: ${labelMap[canState()] ?? canState()} · ComM: ${labelMap[commActual()] ?? commActual()}`;
  if (runtimeTab !== 'can') return;
  $('can-empty').hidden = state.frames.length > 0;
  if (canState() === 'BUS_OFF') $('can-empty').textContent = 'Bus-Off：应用可以运行，但本场景没有成功的 CAN 收发。';
  else $('can-empty').textContent = '尚无总线流量；等待控制器和通信模式就绪。';
  $('can-frames').innerHTML = state.frames.slice(-28).reverse().map(frame => {
    const id = typeof frame.id === 'number' ? `0x${frame.id.toString(16).toUpperCase()}` : frame.id;
    const data = frame.data.map(byte => Number(byte).toString(16).toUpperCase().padStart(2, '0')).join(' ');
    return `<tr title="${escape(frame.label)}"><td>${number(frame.time).toFixed(3)}</td><td class="frame-${frame.direction.toLowerCase()}">${escape(frame.direction)}</td><td>${escape(id)}</td><td>${escape(data)}</td></tr>`;
  }).join('');
}

function renderDirectory() {
  if (!$('steps-dialog').open) return;
  $('step-directory').innerHTML = PHASES.map(phase => `<section class="directory-phase"><h3>${padded(phase.id + 1)} / ${escape(phase.title)}</h3>${STEPS.filter(step => step.phase === phase.id).map(step =>
    `<div class="directory-row${step.id === state.cursor ? ' current' : ''}"><button class="directory-bp${player.breakpoints.has(step.id) ? ' set' : ''}" data-breakpoint="${step.id}" aria-label="${player.breakpoints.has(step.id) ? '移除' : '设置'}第 ${step.id} 步断点" aria-pressed="${player.breakpoints.has(step.id)}"><span></span></button><button class="directory-jump" data-jump="${step.id}" aria-label="跳转到第 ${step.id} 步：${escape(step.title)}"><span class="directory-num">${padded(step.id)}</span><span class="directory-title">${escape(step.title)}</span><code class="directory-api">${escape(step.api)}</code></button></div>`).join('')}</section>`).join('');
  $('breakpoint-count').textContent = `${player.breakpoints.size} 个断点`;
}

function udsLink() {
  const dcmReady = ['ready', 'active'].includes(state.modules?.dcm);
  const canReady = state.can?.actual === 'FULL_COM' && state.can?.txEnabled === true;
  if (!dcmReady) return { available: false, label: 'DCM 未就绪', detail: '运行到第 28 步以后' };
  if (!canReady) return { available: false, label: 'CAN 链路不可用', detail: `actual=${state.can?.actual ?? 'UNAVAILABLE'}` };
  return { available: true, label: 'ONLINE · 7E0 / 7E8', detail: 'DCM + CanTp + CAN 已就绪' };
}

function markUdsGoals(transaction) {
  if (!transaction?.positive) return;
  const request = transaction.request;
  if (request[0] === 0x22 && request[1] === 0xf1 && request[2] === 0x90) udsGoals.add('vin');
  if (request[0] === 0x10 && request[1] === 0x03) udsGoals.add('session');
  if (request[0] === 0x19 && request[1] === 0x02) udsGoals.add('dtc');
  if (udsState.security === 'unlocked') udsGoals.add('security');
}

function selectedFlashProfile() {
  return UDS_FLASH_PROFILES.find(profile => profile.id === $('flash-profile-select').value) ?? UDS_FLASH_PROFILES[0];
}

function renderFlashProfileMeta() {
  const profile = selectedFlashProfile();
  $('flash-image-meta').innerHTML = `<span><small>VERSION</small><strong>${escape(profile.version)}</strong></span><span><small>ADDRESS</small><code>0x${Number(profile.address).toString(16).toUpperCase().padStart(8, '0')}</code></span><span><small>SIZE</small><strong>${profile.bytes.length} B</strong></span><span><small>CRC32</small><code>${Number(profile.checksum).toString(16).toUpperCase().padStart(8, '0')}</code></span>`;
}

function resetFlashUi() {
  flashPlan = null;
  flashCursor = 0;
  flashRunLog = [];
}

function recordFlashStep(label, transaction) {
  flashRunLog.push({ label, transaction });
}

function renderFlash() {
  const flash = udsState.flash;
  const link = udsLink();
  renderFlashProfileMeta();
  for (const bank of ['A', 'B']) {
    const element = $(`flash-bank-${bank.toLowerCase()}`);
    const active = flash.activeBank === bank;
    const target = !active && !['idle', 'activated'].includes(flash.status);
    element.classList.toggle('active', active);
    element.classList.toggle('target', target);
    element.querySelector('strong').textContent = active ? `ACTIVE · ${flash.activeVersion}` : target && flash.targetVersion ? `TARGET · ${flash.targetVersion}` : 'INACTIVE';
  }
  const statusNames = {
    idle: 'IDLE · 等待准备', erased: 'ERASED · 已擦除', 'download-requested': 'DOWNLOAD REQUESTED',
    transferring: 'TRANSFERRING · 数据传输中', transferred: 'TRANSFERRED · 等待校验',
    verified: 'VERIFIED · 等待激活', activated: 'ACTIVATED · 刷写完成', failed: 'FAILED · 刷写中止',
  };
  $('flash-status').textContent = statusNames[flash.status] ?? flash.status;
  $('flash-status').dataset.state = flash.status === 'activated' ? 'healthy' : flash.status === 'failed' ? 'error' : 'warning';
  $('flash-progress-label').textContent = `${flash.progress}%`;
  $('flash-progress-bar').style.width = `${Math.max(0, Math.min(100, flash.progress))}%`;
  const next = flashPlan?.requests[flashCursor];
  $('flash-current-step').textContent = next ? `下一步：${next.label} · ${formatHex(next.request)}`
    : flash.status === 'activated' ? `活动分区 ${flash.activeBank} · ${flash.activeVersion}`
      : flashPlan ? '计划已执行完毕。' : '刷写仅修改浏览器内存中的教学状态。';
  $('flash-prepare').disabled = !link.available;
  $('flash-next').disabled = !link.available || !next;
  $('flash-auto').disabled = !link.available;
  $('flash-profile-select').disabled = flashPlan && flashCursor < flashPlan.requests.length;
  $('flash-step-log').innerHTML = flashRunLog.length ? flashRunLog.map((entry, index) => {
    const transaction = entry.transaction;
    const kind = transaction.positive ? 'positive' : 'negative';
    return `<div class="flash-log-row ${kind}"><span>${padded(index + 1)}</span><div><strong>${escape(entry.label)}</strong><code>${escape(transaction.requestHex)} → ${escape(transaction.responseHex || 'NO RESPONSE')}</code></div></div>`;
  }).join('') : '<div class="flash-log-empty">准备后逐步观察编程会话、SecurityAccess、擦除、传输、校验和激活。</div>';
  $('flash-step-log').scrollTop = $('flash-step-log').scrollHeight;
}

function prepareFlash() {
  if (!udsLink().available) { notify('DCM 或诊断 CAN 链路尚未就绪。', true); return false; }
  const profile = selectedFlashProfile();
  flashPlan = buildFlashRequestPlan(profile.id);
  flashCursor = 0;
  flashRunLog = [];
  const session = uds.request('10 02', state);
  recordFlashStep('进入编程会话', session);
  if (!session.positive) { renderUds(); return false; }
  const seed = uds.request('27 01', state);
  recordFlashStep('请求 SecurityAccess Seed', seed);
  if (!seed.positive) { renderUds(); return false; }
  const key = uds.request([0x27, 0x02, ...deriveTeachingKey(seed.response.slice(2))], state);
  recordFlashStep('发送教学 Key', key);
  udsState = uds.getSnapshot();
  markUdsGoals(key);
  renderUds();
  if (!key.positive) return false;
  notify(`${profile.label} 刷写环境已准备；可逐步执行或自动完成。`);
  return true;
}

function runFlashStep() {
  const item = flashPlan?.requests[flashCursor];
  if (!item) return false;
  const transaction = uds.request(item.request, state);
  $('uds-request-input').value = formatHex(item.request);
  recordFlashStep(item.label, transaction);
  if (transaction.positive) flashCursor += 1;
  renderUds();
  if (!transaction.positive) notify(`${transaction.summary}：${transaction.explanation}`, true);
  else if (flashCursor === flashPlan.requests.length) notify(`刷写演示完成：${uds.getSnapshot().flash.activeVersion} 已切换为活动版本。`);
  else notify(transaction.summary);
  return transaction.positive;
}

function autoFlash() {
  if ((!flashPlan || flashCursor >= flashPlan.requests.length) && !prepareFlash()) return;
  let failure = null;
  while (flashCursor < flashPlan.requests.length) {
    const item = flashPlan.requests[flashCursor];
    const transaction = uds.request(item.request, state);
    $('uds-request-input').value = formatHex(item.request);
    recordFlashStep(item.label, transaction);
    if (!transaction.positive) { failure = transaction; break; }
    flashCursor += 1;
  }
  renderUds();
  if (failure) notify(`${failure.summary}：${failure.explanation}`, true);
  else notify(`教学刷写完成：活动分区 ${udsState.flash.activeBank} · ${udsState.flash.activeVersion}`);
}

function renderUds() {
  udsState = uds.getSnapshot();
  const link = udsLink();
  $('uds-link-state').textContent = link.label;
  $('uds-link-state').title = link.detail;
  $('uds-link-state').dataset.state = link.available ? 'healthy' : 'warning';
  const sessionNames = { default: '默认会话 · 01', programming: '编程会话 · 02', extended: '扩展会话 · 03' };
  $('uds-session-state').textContent = sessionNames[udsState.session] ?? udsState.session;
  $('uds-security-state').textContent = udsState.security === 'unlocked' ? 'UNLOCKED' : udsState.security === 'delay' ? 'DELAY · NRC 37' : 'LOCKED';
  $('uds-security-state').dataset.state = udsState.security === 'unlocked' ? 'healthy' : udsState.security === 'delay' ? 'error' : 'warning';
  $('uds-dtc-count').textContent = String(udsState.dtcCount);
  const runButton = $('uds-run-to-ready');
  runButton.disabled = state.status === 'running' && link.available;
  runButton.textContent = state.status === 'running' ? (link.available ? 'ECU 已进入 RUN' : '重新运行当前场景') : '运行 ECU 到 RUN';
  $('uds-auto-key').disabled = !udsState.pendingSeed || udsState.security !== 'locked';

  const latest = udsState.latest;
  if (!latest) {
    $('uds-latest').innerHTML = '<span class="uds-placeholder">先让 ECU 进入 RUN，再读取 VIN：<code>22 F1 90</code></span>';
  } else {
    const response = latest.outcome === 'suppressed-positive-response' ? '正响应已抑制' : latest.responseHex || '无响应';
    const responseClass = latest.outcome === 'positive' || latest.outcome === 'suppressed-positive-response' ? 'positive' : latest.outcome === 'negative' ? 'negative' : 'transport';
    const dtcs = latest.dtcs?.length ? `<div class="uds-dtc-records">${latest.dtcs.map(dtc => `<span><code>${Number(dtc.id).toString(16).toUpperCase().padStart(6, '0')}</code>${escape(dtc.label)} · status ${Number(dtc.status).toString(16).toUpperCase().padStart(2, '0')}</span>`).join('')}</div>` : '';
    $('uds-latest').innerHTML = `<div class="uds-result-head"><span class="uds-outcome ${responseClass}">${escape(latest.outcome)}</span>${latest.privateProtocol ? '<span class="uds-outcome private">OEM PRIVATE</span>' : ''}<strong>${escape(latest.summary)}</strong></div><div class="uds-message-pair"><div><span>TESTER → ECU</span><code>${escape(latest.requestHex)}</code></div><div><span>ECU → TESTER</span><code>${escape(response)}</code></div></div><p>${escape(latest.explanation)}</p>${dtcs}`;
  }

  const frames = latest?.frames ?? [];
  $('uds-frame-count').textContent = `${frames.length} FRAME${frames.length === 1 ? '' : 'S'}`;
  $('uds-frame-empty').hidden = frames.length > 0;
  $('uds-frame-list').innerHTML = frames.map(frame => `<tr><td><span class="uds-direction ${frame.direction.toLowerCase()}">${escape(frame.direction)}</span></td><td><code>${escape(frame.canId)}</code></td><td><strong>${escape(frame.type)}</strong></td><td><code>${escape(formatHex(frame.data))}</code></td></tr>`).join('');

  for (const goal of document.querySelectorAll('[data-uds-goal]')) goal.classList.toggle('complete', udsGoals.has(goal.dataset.udsGoal));
  $('uds-goal-count').textContent = `${udsGoals.size} / 4 完成`;
  $('uds-history').innerHTML = udsState.history.length ? udsState.history.slice().reverse().map(entry => `<div class="uds-history-row"><span class="uds-history-index">#${padded(entry.id)}</span><code>${escape(entry.requestHex)}</code><span class="uds-history-arrow">→</span><code>${escape(entry.responseHex || (entry.outcome === 'suppressed-positive-response' ? 'SUPPRESSED' : 'NO RESPONSE'))}</code><span class="uds-history-summary">${escape(entry.summary)}</span></div>`).join('') : '<div class="uds-history-empty">尚无事务。负响应也值得记录：它告诉你前置条件缺在哪里。</div>';
  renderFlash();
}

function fillUdsRequest(request) {
  $('uds-request-input').value = request;
  $('uds-request-input').focus();
}

function runUdsRequest(request = $('uds-request-input').value) {
  try {
    const transaction = uds.request(request, state);
    udsState = uds.getSnapshot();
    markUdsGoals(transaction);
    renderUds();
    if (transaction.outcome === 'transport-error') notify(transaction.summary, true);
    else if (transaction.outcome === 'negative') notify(`${transaction.summary}：${transaction.explanation}`, true);
    else notify(transaction.summary);
  } catch (error) {
    notify(error.message, true);
    $('uds-request-input').focus();
  }
}

function render() {
  const previous = state;
  state = engine.getSnapshot();
  if (previous.status !== 'blocked' && state.status === 'blocked') notify(state.blockReason || '启动被阻塞，请检查前置条件。', true);
  renderMetrics();
  renderArchitecture();
  renderInspector();
  renderLogs();
  renderCan();
  drawFlow();
  drawTimeline();
  if (activeWorkspace === 'system') renderSystemLab();
  if ($('steps-dialog').open) renderDirectory();
  renderUds();
}

function togglePlay() {
  if (player.playing) player.pause();
  else { player.play(); lastUpdate = performance.now(); }
  render();
}

function seek(cursor) {
  const result = player.seek(cursor);
  uds.reset();
  udsGoals.clear();
  resetFlashUi();
  selectedModule = null;
  logSignature = '';
  if (result.cursor < cursor) notify(`当前场景在第 ${result.cursor} 步阻塞，不能越过未满足的前置条件。`, true);
  render();
}

function reset(scenario) {
  player.reset(scenario);
  uds.reset();
  udsGoals.clear();
  resetFlashUi();
  selectedModule = null;
  logSignature = '';
  inspectorSignature = '';
  render();
}

function toggleBreakpoint(id) {
  const enabled = player.toggleBreakpoint(id);
  render();
  notify(`${enabled ? '已设置' : '已移除'}第 ${id} 步之前的断点。`);
}

function openDialog(id) {
  player.pause();
  render();
  $(id).showModal();
  if (id === 'steps-dialog') renderDirectory();
}

function switchRuntimeTab(tab) {
  runtimeTab = tab;
  for (const name of ['timeline', 'can']) {
    const selected = name === tab;
    $(`${name}-tab`).classList.toggle('selected', selected);
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
    $(`${name}-view`).hidden = !selected;
  }
  renderCan();
  drawTimeline();
}

function exportTrace() {
  const snapshot = engine.getSnapshot();
  const data = {
    format: 'autosar-startup-lab/1', profile: 'AUTOSAR Classic R24-11 Flexible educational example',
    disclaimer: 'Deterministic teaching data, not a real ECU trace or AUTOSAR conformance claim.',
    breakpoints: [...player.breakpoints].sort((a, b) => a - b), snapshot, uds: uds.getSnapshot(),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `autosar-${snapshot.scenario}-step-${snapshot.cursor}.json`;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('已导出当前教学仿真记录，可用于比较不同场景。');
}

const quizzes = [
  { question: 'NvM_ReadAll() 返回后，是否就可以使用恢复后的标定数据？', options: ['可以，函数返回意味着读取全部完成。', '不可以，必须等待异步作业完成并检查结果。'], answer: 1, explanation: 'NvM_ReadAll 是异步作业。依赖数据的消费者要等待完成状态；CRC 失败时是否使用 ROM 默认值，取决于项目策略。' },
  { question: 'StartOS() 之后，EcuM 如何继续执行启动后期？', options: ['StartOS 返回到 main，继续下一行。', '通过配置的自动启动 OS 任务调用 EcuM_StartupTwo。'], answer: 1, explanation: '控制权已经交给 OS。集成代码配置自动启动任务，并在该上下文中调用 EcuM_StartupTwo，不能把 StartOS 当作普通返回调用。' },
  { question: 'CanSM_RequestComMode 返回 E_OK，是否证明 CAN 已进入 FULL_COMMUNICATION？', options: ['不一定，请求受理和实际模式切换完成是两回事。', '是，所有通信状态请求都是同步完成的。'], answer: 0, explanation: '模式切换包含异步控制器/收发器请求与确认。要看实际模式通知，不能只凭请求返回值开始发报文。' },
  { question: '“NvM 读取完成后才执行 Rte_Start”是所有 AUTOSAR 配置的强制顺序吗？', options: ['是，任何版本与项目都不能改变。', '不是，这是本仿真的保守示例；真正要保护的是数据依赖。'], answer: 1, explanation: 'Flexible 允许项目配置 BswM 启动规则。旧 Fixed 文档也有先启动 RTE、再完成 NvM 数据恢复的示例。不能把一个教学流程当作唯一标准。' },
  { question: '收到 7F 22 31 时，哪个字节表示 NRC？', options: ['7F，因为它总是负响应标识。', '31；7F 是负响应 SID，22 是原请求 SID。'], answer: 1, explanation: 'UDS 负响应格式是 7F + requestSID + NRC，所以 31 才是 RequestOutOfRange。' },
  { question: 'CAN 处于 Bus-Off，诊断仪没有收到响应。这等同于 ECU 返回 NRC 22 吗？', options: ['不等同；传输失败发生在 UDS 响应之前。', '等同；没有响应都应解释为 ConditionsNotCorrect。'], answer: 0, explanation: 'NRC 是 ECU 实际发出的 UDS 负响应。Bus-Off 时请求或响应可能根本没通过 CanTp / CAN，不能虚构一个 NRC。' },
  { question: 'SecurityAccess 的 Seed / Key 示例可以直接用于量产 ECU 吗？', options: ['可以，只要 Seed 每次变化即可。', '不可以；实验算法仅帮助观察状态机，真实算法与密钥必须受保护。'], answer: 1, explanation: '学习实验把算法公开是为了可观察性。量产安全设计需要受保护的密钥、算法、尝试计数和延时策略。' },
  { question: '可以跳过 RequestDownload，直接用 0x36 发送固件块吗？', options: ['不可以；DCM 需要先建立下载事务并重置块序号。', '可以；只要第一个块序号是 01。'], answer: 0, explanation: 'TransferData 依赖先前成功的 RequestDownload/RequestUpload。没有事务上下文应返回 RequestSequenceError，而不是把字节写入未知地址。' },
  { question: '“OEM 私有服务”是否意味着可以绕过 DCM 会话和安全检查？', options: ['不意味着；私有语义仍应配置长度、会话、安全和范围条件。', '意味着；非标准 SID 不需要通用诊断状态管理。'], answer: 0, explanation: '私有只表示服务定义由项目/OEM决定。访问控制依然要明确，否则自定义命令会成为绕过诊断安全边界的入口。' },
];

function renderQuiz() {
  const quiz = quizzes[quizIndex];
  $('quiz-question').textContent = quiz.question;
  $('quiz-options').innerHTML = quiz.options.map((option, index) => `<button class="quiz-option" data-answer="${index}">${String.fromCharCode(65 + index)}. ${escape(option)}</button>`).join('');
  $('quiz-feedback').textContent = '';
}

function bindEvents() {
  $('lab-switcher').addEventListener('click', event => {
    const tab = event.target.closest('[data-lab-view]');
    if (tab) switchWorkspace(tab.dataset.labView);
  });
  $('lab-switcher').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...$('lab-switcher').querySelectorAll('[data-lab-view]')];
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    switchWorkspace(tabs[next].dataset.labView);
    tabs[next].focus();
  });
  $('play-button').addEventListener('click', togglePlay);
  $('step-button').addEventListener('click', () => { player.step(); selectedModule = null; render(); });
  $('previous-button').addEventListener('click', () => seek(Math.max(0, state.cursor - 1)));
  $('reset-button').addEventListener('click', () => reset(state.scenario));
  $('speed-select').addEventListener('change', event => player.setSpeed(Number(event.target.value)));
  $('scenario-select').addEventListener('change', event => { reset(event.target.value); notify('实验场景已切换，ECU 已重新上电准备。'); });
  $('step-scrubber').addEventListener('input', event => seek(Number(event.target.value)));
  $('phase-track').addEventListener('click', event => { const card = event.target.closest('[data-phase]'); if (card) seek(phaseRanges.get(Number(card.dataset.phase)).first - 1); });
  $('architecture-layers').addEventListener('click', event => { const module = event.target.closest('[data-module]'); if (module) { selectedModule = selectedModule === module.dataset.module ? null : module.dataset.module; render(); } });
  $('inspector-content').addEventListener('click', event => {
    const systemLink = event.target.closest('[data-system-lab]');
    if (systemLink) { openSystemLab(systemLink.dataset.systemLab); return; }
    const guide = event.target.closest('[data-module-guide]');
    if (guide) openModuleGuide(guide.dataset.moduleGuide);
  });
  $('module-dialog').addEventListener('click', event => {
    const peer = event.target.closest('[data-module-peer]');
    if (peer) {
      selectedModule = peer.dataset.modulePeer;
      inspectorSignature = '';
      render();
      renderModuleGuide();
      return;
    }
    const step = event.target.closest('[data-module-step]');
    if (step) jumpToModuleStep(Number(step.dataset.moduleStep), step.dataset.moduleOwner);
  });
  $('system-workspace').addEventListener('click', event => {
    const profile = event.target.closest('[data-system-profile]');
    if (profile) {
      stopSystemPlayback();
      systemLab.selectProfile(profile.dataset.systemProfile);
      selectedSystemNode = systemLab.profile.nodes[0].id;
      renderSystemLab();
      $('system-lab-body').scrollTop = 0;
      return;
    }
    const node = event.target.closest('[data-system-node]');
    if (node) { selectedSystemNode = node.dataset.systemNode; renderSystemLab(); return; }
    const step = event.target.closest('[data-system-seek]');
    if (step) { stopSystemPlayback(); systemLab.seek(Number(step.dataset.systemSeek)); renderSystemLab(); return; }
    const action = event.target.closest('[data-system-action]')?.dataset.systemAction;
    if (action === 'reset') { stopSystemPlayback(); systemLab.reset(); renderSystemLab(); }
    else if (action === 'step') { stopSystemPlayback(); systemLab.step(); renderSystemLab(); }
    else if (action === 'play') toggleSystemPlayback();
  });
  $('system-lab-body').addEventListener('change', event => {
    if (event.target.id !== 'system-scenario') return;
    stopSystemPlayback();
    systemLab.selectScenario(event.target.value);
    renderSystemLab();
    $('system-lab-body').scrollTop = 0;
  });
  $('follow-button').addEventListener('click', () => { selectedModule = null; render(); });
  $('breakpoint-button').addEventListener('click', () => { if (state.cursor < STEPS.length) toggleBreakpoint(state.cursor + 1); });
  $('log-filter').addEventListener('input', renderLogs);
  $('autoscroll').addEventListener('change', () => { if ($('autoscroll').checked) $('log-body').scrollTop = $('log-body').scrollHeight; });
  $('steps-open').addEventListener('click', () => openDialog('steps-dialog'));
  $('system-lab-open').addEventListener('click', () => openSystemLab());
  $('guide-open').addEventListener('click', () => openDialog('guide-dialog'));
  $('sources-open').addEventListener('click', () => { openDialog('guide-dialog'); $('scope-section').scrollIntoView({ block: 'start' }); });
  $('export-trace').addEventListener('click', exportTrace);
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  $('step-directory').addEventListener('click', event => {
    const breakpoint = event.target.closest('[data-breakpoint]');
    if (breakpoint) { toggleBreakpoint(Number(breakpoint.dataset.breakpoint)); return; }
    const jump = event.target.closest('[data-jump]');
    if (jump) { seek(Number(jump.dataset.jump)); $('steps-dialog').close(); }
  });
  $('clear-breakpoints').addEventListener('click', () => { player.breakpoints.clear(); player.stoppedAtBreakpoint = null; render(); notify('所有断点已清除。'); });
  $('uds-run-to-ready').addEventListener('click', () => {
    seek(STEPS.length);
    if (udsLink().available) notify('ECU 已进入 RUN，DCM 与诊断 CAN 链路可用。');
    else notify('ECU 已运行到当前场景终点，但诊断链路仍不可用；请观察 CAN / DCM 状态。', true);
  });
  $('uds-request-form').addEventListener('submit', event => { event.preventDefault(); runUdsRequest(); });
  $('uds-workspace').addEventListener('click', event => {
    const direct = event.target.closest('[data-uds-send]');
    if (direct) {
      fillUdsRequest(direct.dataset.udsSend);
      runUdsRequest(direct.dataset.udsSend);
      return;
    }
    const preset = event.target.closest('[data-uds-request]');
    if (preset) fillUdsRequest(preset.dataset.udsRequest);
  });
  $('uds-auto-key').addEventListener('click', () => {
    if (!udsState.pendingSeed) return;
    fillUdsRequest(`27 02 ${formatHex(deriveTeachingKey(udsState.pendingSeed))}`);
  });
  $('uds-reset').addEventListener('click', () => { uds.reset(); resetFlashUi(); renderUds(); notify('诊断会话、安全状态、刷写分区和示例 DTC 已重置。'); });
  $('flash-profile-select').addEventListener('change', () => { resetFlashUi(); renderUds(); });
  $('flash-prepare').addEventListener('click', prepareFlash);
  $('flash-next').addEventListener('click', runFlashStep);
  $('flash-auto').addEventListener('click', autoFlash);
  for (const name of ['timeline', 'can']) {
    $(`${name}-tab`).addEventListener('click', () => switchRuntimeTab(name));
    $(`${name}-tab`).addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const other = name === 'timeline' ? 'can' : 'timeline'; switchRuntimeTab(other); $(`${other}-tab`).focus(); } });
  }
  $('quiz-options').addEventListener('click', event => {
    const option = event.target.closest('[data-answer]');
    if (!option) return;
    const quiz = quizzes[quizIndex];
    const correct = Number(option.dataset.answer) === quiz.answer;
    for (const item of $('quiz-options').children) { item.classList.remove('correct', 'incorrect'); item.setAttribute('aria-pressed', String(item === option)); }
    option.classList.add(correct ? 'correct' : 'incorrect');
    $('quiz-feedback').textContent = `${correct ? '答对了。' : '再想一下。'}${quiz.explanation}`;
  });
  $('quiz-next').addEventListener('click', () => { quizIndex = (quizIndex + 1) % quizzes.length; renderQuiz(); });
  document.addEventListener('keydown', event => {
    if (activeWorkspace !== 'startup' || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
    if (event.target.closest('input,select,textarea,button,a,[contenteditable="true"]')) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); player.step(); selectedModule = null; render(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(Math.max(0, state.cursor - 1)); }
    else if (event.key.toLowerCase() === 'r') reset(state.scenario);
    else if (event.key.toLowerCase() === 'b' && state.cursor < STEPS.length) toggleBreakpoint(state.cursor + 1);
  });
  document.addEventListener('visibilitychange', () => { lastUpdate = performance.now(); });
  const observer = new ResizeObserver(() => { drawFlow(); drawTimeline(); });
  observer.observe($('architecture'));
  observer.observe($('timeline-view'));
}

prepareLabWorkspaces();
buildStaticViews();
bindEvents();
render();
setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(250, Math.max(0, now - lastUpdate));
  lastUpdate = now;
  if (!player.playing || document.hidden) return;
  const result = player.advance(elapsed);
  if (result.changed || result.breakpoint) render();
  if (result.breakpoint) notify(`已在第 ${result.breakpoint} 步执行前暂停。继续播放或单步可越过此断点一次。`);
}, 80);
