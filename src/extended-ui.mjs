import { TransportSimulator } from './transport-lab.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = bytes => (bytes || []).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const button = (action, label, extra = '') => `<button type="button" class="button" data-ext="${action}" ${extra}>${label}</button>`;
const panel = (title, body, subtitle = '') => `<section class="ext-panel"><header><h3>${title}</h3>${subtitle ? `<p>${subtitle}</p>` : ''}</header>${body}</section>`;
const flow = (items, active) => `<div class="ext-flow">${items.map(item => `<span class="${item === active ? 'active' : ''}">${esc(item)}</span>`).join('<b aria-hidden="true">→</b>')}</div>`;
const events = list => `<div class="ext-events">${list.slice(-12).reverse().map(e => `<p><time>${Math.round(e.timeMs ?? e.time ?? 0)} ms</time> ${esc(e.message ?? e.detail)}</p>`).join('') || '<p>操作后将在这里显示事件。</p>'}</div>`;
const field = (name, title, value, min = 0, max = 100, step = 1) => `<label>${title}<input name="${name}" type="number" value="${esc(value)}" min="${min}" max="${max}" step="${step}" required></label>`;

export class ExtendedLabUi {
  constructor({ world, advance, onChange, notify, actions = {} }) {
    this.world = world; this.advance = advance; this.onChange = onChange; this.notify = notify || (() => {});
    this.actions = actions;
    this.filter = 'ALL'; this.transport = new TransportSimulator(); this.workspace = null;
    this.bound = new WeakSet();
    this.draftIdentity = new WeakMap();
  }
  tick(ms) { this.transport.tick(ms); }
  render(workspace) {
    this.workspace = workspace;
    const id = workspace === 'system' ? 'live-system-content' : `${workspace}-content`;
    const root = document.getElementById(id);
    const methods = { communication: 'communication', storage: 'storage', scheduler: 'scheduler', calibration: 'calibration', system: 'system' };
    if (!root || !methods[workspace]) return;
    const ecu = this.world.ecu();
    const identity = `${ecu.id}:${ecu.volatileRevision}`;
    const preserveDrafts = this.draftIdentity.get(root) === identity;
    const focused = preserveDrafts && root.contains(document.activeElement) ? document.activeElement : null;
    const name = focused?.name;
    const values = preserveDrafts ? [...root.querySelectorAll('input,select')].map(el => [el.name, el.value, el.checked]) : [];
    root.classList.add('ext-workspace');
    root.innerHTML = this[methods[workspace]]();
    this.draftIdentity.set(root, identity);
    // Preserve drafts while the virtual clock updates charts and output panels.
    for (const [key, value, checked] of values) {
      if (!key) continue;
      const el = root.querySelector(`[name="${key}"]`);
      if (el) { el.value = value; if (el.type === 'checkbox') el.checked = checked; }
    }
    if (name) root.querySelector(`[name="${name}"]`)?.focus({ preventScroll: true });
    if (!this.bound.has(root)) {
      root.addEventListener('click', e => {
        const target = e.target.closest('[data-ext]');
        if (target) this.act(target.dataset.ext, target, root);
      });
      root.addEventListener('submit', e => { e.preventDefault(); this.act(e.target.dataset.form, e.target, root); });
      this.bound.add(root);
    }
  }
  act(action, target, root) {
    const world = this.world; const ecu = world.ecu();
    const value = name => root.querySelector(`[name="${name}"]`)?.value;
    try {
      switch (action) {
        case 'step10': this.advance(10); return;
        case 'step100': this.advance(100); return;
        case 'step1000': this.advance(1000); return;
        case 'filter': this.filter = target.dataset.kind; break;
        case 'request': world.requestNetwork(ecu.id, true); break;
        case 'release': world.requestNetwork(ecu.id, false); break;
        case 'release-all': for (const item of Object.values(world.ecus)) world.requestNetwork(item.id, false); break;
        case 'wake': world.wake(); break;
        case 'power-off': (this.actions.powerOff || world.powerOff.bind(world))(target.dataset.ecu || ecu.id); break;
        case 'power-on': (this.actions.powerOn || world.start.bind(world))(target.dataset.ecu || ecu.id); break;
        case 'select': world.select(target.dataset.ecu); break;
        case 'bus-off': world.setBusOff(target.dataset.ecu, !world.ecu(target.dataset.ecu).busOff); break;
        case 'start-all': (this.actions.startAll || world.startAll.bind(world))(); break;
        case 'cdd-fault': world.setCddFault(!ecu.cdd.fault); break;
        case 'write': if (!ecu.storage.writeBlock(value('block'), Number(value('block-value')))) throw new Error('写入被拒绝：检查电源、写保护和队列'); break;
        case 'protect': ecu.storage.setWriteProtected(!ecu.storage.getSnapshot().writeProtected); break;
        case 'crc': ecu.storage.injectCrcFault(); break;
        case 'gc': for (let i = 0; i < 12; i++) if (!ecu.storage.writeBlock('threshold', 40 + i)) break; break;
        case 'diagnostic': world.os.activate('diagnostic'); break;
        case 'cat1': world.os.triggerInterrupt(0, 1); break;
        case 'cat2': world.os.triggerInterrupt(0, 2); break;
        case 'event': world.os.setEvent(); break;
        case 'core': { const core = world.os.getSnapshot().cores.at(-1); world.os.setCoreOnline(core.id, !core.online); break; }
        case 'lock': world.os.setLockContention(!world.os.getSnapshot().spinlock.enabled); break;
        case 'ioc': world.os.sendIoc(value('ioc-value') || 'Hello Core'); break;
        case 'connect': world.connectXcp(); break;
        case 'disconnect': ecu.xcp.disconnect(); break;
        case 'daq': ecu.xcp.setDaq(!ecu.xcp.getSnapshot().daq); break;
        case 'calibrate': for (const name of ['gain', 'filter', 'threshold']) world.calibrate(name, Number(value(name))); break;
        case 'sensor': world.setSensor(Number(value('sensor'))); break;
        case 'persist': {
          const result = world.saveCalibration();
          this.notify(result.durable ? '标定值已耐久保存' : result.accepted ? 'NvM 已接受标定，等待提交完成' : 'NvM 暂未接受全部标定，已保留最新参数等待重试', !result.accepted);
          break;
        }
        case 'transport-start':
          this.transport = new TransportSimulator({ canFd: value('transport-mode') === 'fd', blockSize: Number(value('bs')), stMinMs: Number(value('stmin')), timeoutMs: 100 });
          this.transport.setFault(value('transport-fault'));
          this.transport.start(Array.from({ length: Number(value('payload-size')) }, (_, i) => i & 255));
          break;
        case 'transport-step': this.transport.step(); break;
        default: return;
      }
      this.onChange();
    } catch (error) { this.notify(error.message, true); }
  }
  communication() {
    const snapshot = this.world.getSnapshot(); const ecu = snapshot.ecus.find(e => e.id === snapshot.selectedId);
    const rows = snapshot.frames.filter(f => this.filter === 'ALL' || f.kind === this.filter).slice(-35).reverse();
    const app = snapshot.frames.findLast(f => f.kind === 'APP' && f.ecuId === ecu.id);
    const trans = this.transport.getSnapshot();
    return `<div class="ext-grid">${panel('网络状态与休眠', `${flow(['BUS_SLEEP', 'REPEAT_MESSAGE', 'NORMAL_OPERATION', 'READY_SLEEP', 'PREPARE_BUS_SLEEP'], ecu.nm)}<div class="ext-metrics"><span>本地请求 <strong>${ecu.requested ? '保持网络' : '已释放'}</strong></span><span>Repeat 剩余 <strong>${ecu.nm === 'REPEAT_MESSAGE' ? ecu.repeatRemaining : '—'} ms</strong></span><span>Timeout 剩余 <strong>${ecu.nm === 'READY_SLEEP' ? ecu.timeoutRemaining : '—'} ms</strong></span><span>WaitSleep 剩余 <strong>${ecu.nm === 'PREPARE_BUS_SLEEP' ? ecu.waitRemaining : '—'} ms</strong></span></div><div class="ext-actions">${button('request', '请求网络')}${button('release', '释放本 ECU')}${button('release-all', '释放全部 ECU')}${button('wake', '触发唤醒')}${button('step1000', '推进 1 s')}</div><p class="ext-note">其他节点仍发送 NM 时会刷新超时；释放全部节点后继续推进时间，观察 READY_SLEEP → PREPARE_BUS_SLEEP → BUS_SLEEP。</p>`, `${esc(ecu.name)} · 共享整车时钟 ${snapshot.nowMs} ms`)}</div>
      ${panel('应用信号 → CAN 字节', `${flow(['SWC', 'RTE', 'Com', 'PduR', 'CanIf', 'Can Driver'], 'Com')}<div class="ext-byte-grid">${['AliveCounter', 'Actuator', 'Filtered', 'Sensor'].map((label, i) => `<div><small>Byte ${i}</small><strong>${app ? hex([app.data[i]]) : '—'}</strong><span>${label}</span><b>${app ? app.data[i] : '—'}</b></div>`).join('')}</div><p class="ext-note">${esc(app?.canId || '等待应用报文')} 为本项目应用 PDU；数值采用单字节教学编码。NM 报文使用独立 ID 和节点 ID / CBV 布局。</p>`)}
      ${panel('共享总线记录', `<div class="ext-actions">${['ALL', 'APP', 'NM', 'UDS'].map(kind => button('filter', kind, `data-kind="${kind}" aria-pressed="${this.filter === kind}"`)).join('')}</div><div class="ext-table-scroll"><table><thead><tr><th>时间 ms</th><th>ECU</th><th>类型</th><th>方向</th><th>CAN ID</th><th>数据</th><th>解释</th></tr></thead><tbody>${rows.map(f => `<tr><td>${f.time}</td><td>${esc(f.ecuId)}</td><td><span class="ext-badge">${f.kind}</span></td><td>${esc(f.direction)}</td><td>${esc(f.canId)}</td><td class="ext-mono">${hex(f.data)}</td><td>${esc(f.detail)}</td></tr>`).join('') || '<tr><td colspan="7">启动 ECU 并推进时间，观察应用与网络管理报文。</td></tr>'}</tbody></table></div>`)}
      ${panel('ISO-TP 逐帧传输台', `<form data-form="transport-start" class="ext-form"><label>链路<select name="transport-mode"><option value="classic">Classic CAN · 8 bytes</option><option value="fd">CAN FD · 64 bytes</option></select></label><label>负载<select name="payload-size"><option>24</option><option>100</option></select></label>${field('bs', 'Block Size', 2, 0, 16)}${field('stmin', 'STmin (ms)', 10, 0, 50)}<label>故障<select name="transport-fault"><option value="none">正常</option><option value="drop-fc">丢失 FC</option><option value="drop-cf">丢失 CF</option><option value="wrong-sequence">错误序号</option></select></label><button class="button primary">开始传输</button></form><div class="ext-actions">${button('transport-step', '执行下一帧 / 超时')}<span class="ext-badge">${esc(trans.status)}</span><span>本地时间 ${trans.nowMs} ms · 已接收 ${trans.received?.length || 0} bytes · ${esc(trans.nextAction || '')}</span></div><p class="ext-note">独立传输相对时钟；单步只推进传输台，全局时间推进也会驱动此实验。对比相同负载在两种链路中的分帧数量。${esc(trans.error || '')}</p><div class="ext-table-scroll"><table><thead><tr><th>时间</th><th>帧型</th><th>方向</th><th>数据</th></tr></thead><tbody>${(trans.frames || []).map(f => `<tr><td>${f.time}</td><td>${esc(f.type)}</td><td>${esc(f.direction)}</td><td class="ext-mono">${hex(f.data)}</td></tr>`).join('')}</tbody></table></div>`)}`;
  }
  storage() {
    const ecu = this.world.ecu(); const s = ecu.storage.getSnapshot();
    return `<div class="ext-grid">${panel('异步写入与掉电恢复', `<form class="ext-form" data-form="write"><label>NvM Block<select name="block"><option>gain</option><option>filter</option><option>threshold</option></select></label>${field('block-value', '新值', 2, 0, 100, 0.01)}<button class="button primary">NvM_WriteBlock</button></form>${flow(['NvM', 'MemIf', 'Fee', 'Fls', 'verify', 'commit'], s.activeJob?.stage)}<div class="ext-metrics"><span>阶段<strong>${esc(s.status)}</strong></span><span>等待队列<strong>${s.queue.length}</strong></span><span>GC 次数<strong>${s.gcCount}</strong></span></div><div class="ext-actions">${button('step10', '推进 10 ms')}${button('step100', '推进 100 ms')}${button('crc', '下一次写入 CRC 故障')}${button('protect', s.writeProtected ? '取消写保护' : '开启写保护')}${button('gc', '排队 12 次写入 / 触发 GC')}${button('power-off', '立即断电')}${button('power-on', '上电恢复')}</div><p class="ext-note">请求受理不等于持久化。观察 verify 与 commit 的边界，途中断电后只恢复已提交记录。GC 使用先复制再切换的教学模型。</p>`, `${esc(ecu.name)} · ${s.powered ? '电源开启' : '已断电'}`)}${panel('已提交的持久化值', `<div class="ext-table-scroll"><table><thead><tr><th>Block</th><th>Value</th></tr></thead><tbody>${Object.entries(s.blocks).map(([key, val]) => `<tr><td>${esc(key)}</td><td>${esc(JSON.stringify(val))}</td></tr>`).join('')}</tbody></table></div><p class="ext-note">标定实验的“保存”也进入这一个队列；改变 NvM 值需要重启才加载到标定 RAM。</p>`)}</div>${panel('Flash 双扇区与记录提交', `<div class="ext-sectors">${s.sectors.map((sector, i) => `<section><h4>Sector ${i} ${i === s.activeSector ? '· ACTIVE' : '· STANDBY'}</h4><div class="ext-cells">${Array.from({ length: s.capacity }, (_, j) => { const record = sector[j]; return `<div class="${record ? record.committed ? 'committed' : 'pending' : ''}"><small>Slot ${j}</small>${record ? `<strong>${esc(record.name)}</strong><span>${esc(JSON.stringify(record.value))}</span><small>${record.committed ? 'COMMITTED' : record.valid ? 'VERIFIED' : 'UNVERIFIED'}</small>` : '<span>ERASED</span>'}</div>`; }).join('')}</div></section>`).join('')}</div>`)}${panel('存储事件', events(s.events))}`;
  }
  scheduler() {
    const s = this.world.os.getSnapshot(); const end = Math.max(100, s.nowMs); const start = Math.max(0, end - 200); const span = end - start;
    const colors = { control: '#159b89', comm: '#5585dc', background: '#a2afbe', diagnostic: '#ad6fc4', event: '#dbb457' };
    const svg = `<svg viewBox="0 0 900 ${s.cores.length * 52 + 35}" role="img" aria-label="各核最近 200 毫秒任务执行时间线"><text x="85" y="15">${start} ms</text><text x="805" y="15">${end} ms</text>${s.cores.map((core, i) => `<text x="8" y="${50 + i * 52}">Core ${core.id}</text><line x1="85" y1="${63 + i * 52}" x2="885" y2="${63 + i * 52}" stroke="#e4e9ef"/>`).join('')}${s.timeline.filter(t => t.end > start).map(t => { const x = 85 + (Math.max(t.start, start) - start) / span * 800; const width = (t.end - Math.max(t.start, start)) / span * 800; return `<rect x="${x}" y="${29 + t.core * 52}" width="${Math.max(1, width)}" height="30" rx="3" fill="${colors[t.task] || '#d98271'}"><title>${esc(t.task)} ${t.start}–${t.end} ms</title></rect>`; }).join('')}</svg>`;
    return `${panel('固定优先级抢占与多核运行', `<div class="ext-actions">${button('step10', '推进 10 ms')}${button('step100', '推进 100 ms')}${button('diagnostic', '激活高优先级诊断任务')}${button('cat1', 'Core 0 · Cat1 中断')}${button('cat2', 'Core 0 · Cat2 中断')}${button('event', 'SetEvent')}${button('core', '切换末核在线状态')}${button('lock', s.spinlock.enabled ? '关闭锁竞争' : '开启锁竞争')}</div><div class="ext-chart">${svg}</div><div class="ext-legend">${Object.entries(colors).map(([name, color]) => `<span><i style="background:${color}"></i>${name}</span>`).join('')}</div><p class="ext-note">调度器使用 1 ms 粒度，由 Gateway RUN 与全局时间驱动。Cat1 不调用 OS 服务，Cat2 在返回时 SetEvent；离线核保留待执行任务，超过截止时间记录错误。</p>`)}<div class="ext-grid">${panel('任务状态与截止时间', `<div class="ext-table-scroll"><table><thead><tr><th>Task</th><th>Core</th><th>Prio</th><th>状态</th><th>剩余 / ms</th><th>完成</th><th>超期</th></tr></thead><tbody>${s.tasks.map(t => `<tr><td>${esc(t.id)}</td><td>${t.core}</td><td>${t.priority}</td><td>${esc(t.state)}</td><td>${t.remaining}</td><td>${t.completed}</td><td>${t.deadlineMisses}</td></tr>`).join('')}</tbody></table></div>`)}${panel('IOC · Spinlock · 核可用性', `<form data-form="ioc" class="ext-form"><label>IOC 消息<input name="ioc-value" value="Hello Core 2" maxlength="100"></label><button class="button">发送 IOC</button></form><p class="ext-note">接收端 comm 被调度时按序取出消息。</p><div class="ext-metrics"><span>队列<strong>${s.ioc.queue.length}</strong></span><span>锁持有者<strong>${esc(s.spinlock.owner || '无')}</strong></span><span>等待者<strong>${esc(s.spinlock.waiters.join(', ') || '无')}</strong></span><span>屏障可用性<strong>${esc(s.barrier)}</strong></span></div>${events(s.ioc.deliveries.map(d => ({ time: d.receivedAt, message: `#${d.sequence} ${JSON.stringify(d.value)}` })))}`)}</div>${panel('OS 事件', events(s.events))}`;
  }
  calibration() {
    const ecu = this.world.ecu(); const s = ecu.xcp.getSnapshot(); const stored = ecu.storage.getSnapshot().blocks;
    const points = key => s.samples.slice(-100).map((sample, i, all) => `${30 + i / Math.max(1, all.length - 1) * 830},${200 - Math.max(0, Math.min(100, Number(sample.signals[key]) || 0)) * 1.7}`).join(' ');
    return `<div class="ext-grid">${panel('XCP 连接与 RAM 标定', `<div class="ext-actions">${button('connect', '连接 XCP')}${button('disconnect', '断开')}${button('daq', s.daq ? '停止 DAQ' : '开始 DAQ')}${button('persist', '保存标定到 NvM')}<span class="ext-badge">${s.connected ? 'CONNECTED' : 'DISCONNECTED'} · DAQ ${s.daq ? 'ON' : 'OFF'}</span></div><form data-form="calibrate" class="ext-form">${field('gain', 'Gain · 0–10', s.parameters.gain, 0, 10, 0.1)}${field('filter', 'Filter · 0.01–1', s.parameters.filter, 0.01, 1, 0.01)}${field('threshold', 'Threshold · 0–100', s.parameters.threshold)}<button class="button primary">应用 RAM 参数</button></form><p class="ext-note">演示连接、测量与标定流程，不解析 ASAM XCP 报文。采样周期 10 ms，断电或链路不可用时连接终止。</p>`)}${panel('输入与掉电保持', `<form data-form="sensor" class="ext-form">${field('sensor', '传感器输入 · 0–100', ecu.sensor)}<button class="button">应用输入</button></form><div class="ext-actions">${button('step100', '推进 100 ms')}${button('step1000', '推进 1 s')}</div><table><thead><tr><th>参数</th><th>RAM</th><th>NvM 已提交</th></tr></thead><tbody>${Object.entries(s.parameters).map(([name, val]) => `<tr><td>${name}</td><td>${val}</td><td>${esc(stored[name])}</td></tr>`).join('')}</tbody></table><p class="ext-note">输出 = clamp((filtered − threshold) × gain, 0, 100)。保存操作需等待存储提交；重启后从 NvM 恢复。</p>`)}</div>${panel('实时测量 · 最近 100 个样本', `<div class="ext-chart"><svg viewBox="0 0 900 230" role="img" aria-label="传感器、滤波与执行器数值曲线"><text x="3" y="35">100</text><text x="12" y="204">0</text><path d="M30 30V200H865" fill="none" stroke="#ccd6df"/>${[['sensor', '#5585dc'], ['filtered', '#159b89'], ['actuator', '#dc9e37']].map(([key, color]) => `<polyline points="${points(key)}" fill="none" stroke="${color}" stroke-width="2.5"/>`).join('')}<text x="30" y="225">${s.samples.length ? `${s.samples.slice(-100)[0].timeMs} → ${s.samples.at(-1).timeMs} ms` : '连接并开启 DAQ，推进时间开始采样'}</text></svg></div><div class="ext-legend"><span><i style="background:#5585dc"></i>Sensor ${ecu.sensor.toFixed(1)}</span><span><i style="background:#159b89"></i>Filtered ${ecu.filtered.toFixed(1)}</span><span><i style="background:#dc9e37"></i>Actuator ${ecu.actuator.toFixed(1)}</span></div>`)}${panel('标定事件', events(s.events))}`;
  }
  system() {
    const s = this.world.getSnapshot(); const cdd = this.world.ecu().cdd;
    return `${panel('整车运行实例', `<div class="ext-actions">${button('start-all', '启动全部 ECU')}${button('step100', '推进 100 ms')}${button('step1000', '推进 1 s')}</div><div class="ext-ecu-grid">${s.ecus.map(e => `<article class="ext-ecu ${e.id === s.selectedId ? 'selected' : ''}"><span class="ext-badge">${e.powered ? e.busOff ? 'BUS-OFF' : e.bootStatus : 'OFF'}</span><h4>${esc(e.name)}</h4><p>${esc(e.network)}</p><dl><dt>NM</dt><dd>${esc(e.nm)}</dd><dt>Session</dt><dd>${esc(typeof e.session === 'object' ? e.session.name ?? e.session.id : e.session)}</dd><dt>丢失节点</dt><dd>${esc(e.missingPeers.join(', ') || '无')}</dd></dl><div class="ext-actions">${button('select', '选择', `data-ecu="${e.id}"`)}${button(e.powered ? 'power-off' : 'power-on', e.powered ? '断电' : '启动', `data-ecu="${e.id}"`)}${button('bus-off', e.busOff ? '恢复总线' : 'Bus-Off', `data-ecu="${e.id}"`)}</div></article>`).join('')}</div><p class="ext-note">这些是共享时钟中的实际教学 ECU 实例，诊断、存储和标定状态相互独立。下方架构步骤用于讲解设计关系；上方操作影响各实验室运行状态。</p>`)}${panel('CDD 双缓冲采集', `${flow(['DMA', 'IRQ', 'SchM', 'RTE'], cdd.fault ? 'IRQ' : 'RTE')}<div class="ext-byte-grid"><div><small>DMA A</small><strong>${esc(cdd.dma[0] ?? '—')}</strong><span>${cdd.writeBuffer === 0 ? 'NEXT WRITE' : 'STABLE'}</span></div><div><small>DMA B</small><strong>${esc(cdd.dma[1] ?? '—')}</strong><span>${cdd.writeBuffer === 1 ? 'NEXT WRITE' : 'STABLE'}</span></div><div><small>Published</small><strong>${esc(cdd.published ?? '—')}</strong><span>${esc(cdd.quality)}</span></div><div><small>IRQ count</small><strong>${cdd.irqCount}</strong><span>${esc(cdd.phase)}</span></div></div><div class="ext-actions">${button('cdd-fault', cdd.fault ? '恢复 CDD 数据校验' : '注入 CDD CRC 故障')}</div><p class="ext-note">CRC 故障会停止有效数据发布、执行器进入安全输出，并向本 ECU Dem 报告 DTC；可到诊断和存储实验室追踪。</p>`)}${panel('跨 ECU 事件', events(s.events))}`;
  }
}
