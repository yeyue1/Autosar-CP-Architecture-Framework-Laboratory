const profile = (value) => Object.freeze(value);

export const SYSTEM_LAB_SCENARIOS = Object.freeze([
  { id: 'normal', label: '正常启动', description: '按教学配置完成全部依赖与同步点。' },
  { id: 'fault', label: '注入教学故障', description: '在关键依赖处注入可观察的失败。' },
]);

export const SYSTEM_LAB_PROFILES = Object.freeze([
  profile({
    id: 'cdd',
    label: 'CDD 深入',
    caption: 'COMPLEX DRIVER · SPECIAL HARDWARE',
    summary: '用一个特殊角度传感 ASIC，观察 CDD 如何直接面对硬件，同时仍受模式、并发、错误与 AUTOSAR 接口约束。',
    distinction: 'CDD 是单个 ECU 内的项目扩展边界；它不是绕过 RTE、SchM、EcuM/BswM、Det/Dem 和内存映射规则的万能通道。',
    groups: [
      { id: 'hardware', label: '特殊硬件', caption: 'NON-STANDARD ASIC', nodes: ['angle-asic'] },
      { id: 'driver', label: '驱动与扩展', caption: 'MCAL + COMPLEX DRIVER', nodes: ['spi', 'cdd-angle'] },
      { id: 'coordination', label: '系统协作', caption: 'MODE / SCHEDULING / ERROR', nodes: ['mode', 'schm', 'error'] },
      { id: 'application', label: '功能接口', caption: 'RTE + SWC', nodes: ['rte-port', 'sensor-swc'] },
    ],
    nodes: [
      { id: 'angle-asic', label: '角度传感 ASIC', short: 'ASIC', owner: '板级特殊硬件', description: '标准 MCAL 未覆盖的项目专用器件，具有 SPI 帧、IRQ 与自检状态。' },
      { id: 'spi', label: 'Spi Driver', short: 'MCAL', owner: '标准 MCAL', description: 'CDD 优先复用标准 Spi 服务，而不是重复实现已有外设驱动。' },
      { id: 'cdd-angle', label: 'Cdd_AngleSensor', short: 'CDD', owner: 'Complex Drivers', description: '封装器件协议、IRQ/DMA、状态机和面向 AUTOSAR 世界的接口。' },
      { id: 'mode', label: 'EcuM / BswM', short: 'MODE', owner: '模式协调', description: '决定 CDD 何时初始化、启动、降级或停止。' },
      { id: 'schm', label: 'SchM / OS', short: 'LOCK', owner: '并发保护', description: '为任务与中断共享资源提供临界区或 OS 保护机制。' },
      { id: 'error', label: 'Det / Dem', short: 'ERROR', owner: '错误域', description: 'Det 承接开发期错误，Dem 承接需要诊断化的运行事件。' },
      { id: 'rte-port', label: 'RTE Port', short: 'RTE', owner: '生成式接口', description: '把经验证的角度数据通过端口交给应用，而不是暴露寄存器。' },
      { id: 'sensor-swc', label: 'Sensor SWC', short: 'SWC', owner: '应用功能', description: '只消费物理量和质量状态，不依赖 ASIC、SPI 通道或中断细节。' },
    ],
    flows: [
      { from: 'angle-asic', to: 'spi', label: 'SPI frame' },
      { from: 'spi', to: 'cdd-angle', label: 'Spi_AsyncTransmit' },
      { from: 'mode', to: 'cdd-angle', label: 'mode request' },
      { from: 'schm', to: 'cdd-angle', label: 'critical section' },
      { from: 'cdd-angle', to: 'error', label: 'Det / Dem report' },
      { from: 'cdd-angle', to: 'rte-port', label: 'validated angle' },
      { from: 'rte-port', to: 'sensor-swc', label: 'sender-receiver' },
    ],
    steps: [
      { id: 1, title: '建立特殊硬件安全态', api: 'Board_AngleAsicSafeState', actors: ['angle-asic'], description: '上电后先保持输出无效，确认时钟、电源和复位脚满足器件要求。', changes: { 'angle-asic': 'active' } },
      { id: 2, title: '初始化可复用的标准驱动', api: 'Spi_Init', actors: ['spi', 'angle-asic'], description: '装载通道、序列与作业配置，让 CDD 复用标准 Spi 能力。', changes: { 'angle-asic': 'ready', spi: 'ready' } },
      { id: 3, title: '装载 CDD 配置和内存区', api: 'Cdd_AngleSensor_Init', actors: ['cdd-angle'], description: '建立器件状态机、缓冲区、超时与 PB/LT 配置引用。', changes: { 'cdd-angle': 'active' } },
      { id: 4, title: '接收模式管理启动许可', api: 'BswM_CddAngle_RequestMode', actors: ['mode', 'cdd-angle'], description: '由项目模式规则决定何时从初始化态进入可采集状态。', changes: { mode: 'ready', 'cdd-angle': 'ready' } },
      { id: 5, title: '建立 IRQ 与临界区保护', api: 'SchM_Enter_Cdd_AngleBuffer', actors: ['schm', 'cdd-angle'], description: '任务和 ISR 共享缓冲区时使用 SchM 或 OS 机制保护关键资源。', changes: { schm: 'ready', 'cdd-angle': 'active' } },
      { id: 6, title: '完成器件自检和错误映射', api: 'Dem_SetEventStatus', actors: ['cdd-angle', 'error'], description: '把开发错误和可诊断运行故障映射到不同错误域。', changes: { 'cdd-angle': 'ready', error: 'ready' } },
      { id: 7, title: '通过 RTE 发布物理量', api: 'Rte_Write_Angle_Value', actors: ['rte-port', 'sensor-swc'], description: '只在数据质量有效后放行角度值，让 SWC 与器件实现解耦。', changes: { 'rte-port': 'ready', 'sensor-swc': 'ready' } },
    ],
    concepts: [
      { title: '适用场景', text: '标准 MCAL/ECU Abstraction 无法覆盖的 ASIC、特殊时序、资源敏感算法或迁移代码。' },
      { title: '并发边界', text: 'CDD 仍需定义关键区；任务、ISR、DMA 与多核访问不能依赖“调用很快”来保证安全。' },
      { title: '错误与模式', text: '模式可由 EcuM/BswM 管理，开发错误可报 Det，运行故障可进入 Dem。' },
    ],
    fault: {
      at: 6,
      label: 'ASIC CRC 自检失败',
      reason: '角度 ASIC 自检失败，CDD 保持故障安全态，禁止向 RTE 发布数据。',
      mode: 'blocked',
      lockedNodes: ['angle-asic', 'cdd-angle'],
      changes: { 'angle-asic': 'error', 'cdd-angle': 'error' },
    },
    references: [
      { label: 'CDD 设计与集成指南', url: 'https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_CDDDesignAndIntegrationGuideline.pdf' },
      { label: 'Virtual Functional Bus', url: 'https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_VFB.pdf' },
    ],
  }),
  profile({
    id: 'multi-ecu',
    label: '多 ECU 协同',
    caption: 'DISTRIBUTED STARTUP · NETWORK AVAILABILITY',
    summary: '四个独立 Classic ECU 各自启动，再通过 ComM、CanSM、Nm 与网关路由收敛为车辆级可用状态。',
    distinction: '多 ECU 不是一个 EcuM 管理所有控制器；每个 ECU 都有自己的 MCU、EcuM、OS 和故障边界，车辆级协调发生在通信与功能可用性协议上。',
    groups: [
      { id: 'wake', label: '唤醒源', caption: 'VEHICLE INPUT', nodes: ['ignition'] },
      { id: 'ecus', label: '独立 ECU', caption: 'OWN MCU / ECUM / OS', nodes: ['gateway', 'powertrain', 'chassis', 'body'] },
      { id: 'networks', label: '车载网络', caption: 'COMM / NM / ROUTING', nodes: ['pt-can', 'body-can', 'availability'] },
    ],
    nodes: [
      { id: 'ignition', label: 'KL15 / Wakeup', short: 'WAKE', owner: '车辆唤醒源', description: '为多个 ECU 提供直接或间接唤醒条件，但不代替各 ECU 的启动状态机。' },
      { id: 'gateway', label: 'Gateway ECU', short: 'GW', owner: '独立 ECU · Core 0', description: '独立完成 EcuM/OS/BSW 启动，并在网络就绪后建立跨网段路由。' },
      { id: 'powertrain', label: 'Powertrain ECU', short: 'PT', owner: '独立 ECU · Core 0', description: '动力域控制器，独立决定启动完成、通信模式和应用放行。' },
      { id: 'chassis', label: 'Chassis ECU', short: 'CH', owner: '独立 ECU · Core 0', description: '底盘域控制器，通过 PT-CAN 发布自身功能可用性。' },
      { id: 'body', label: 'Body ECU', short: 'BD', owner: '独立 ECU · Core 0', description: '车身域控制器，通过 Body-CAN 和 Nm 参与网络生命周期。' },
      { id: 'pt-can', label: 'PT-CAN Cluster', short: 'CAN A', owner: 'CanSM / CanNm', description: '承载网关、动力与底盘 ECU 的通信和网络管理。' },
      { id: 'body-can', label: 'Body-CAN Cluster', short: 'CAN B', owner: 'CanSM / CanNm', description: '承载网关与车身 ECU 的通信和网络管理。' },
      { id: 'availability', label: 'Vehicle Availability', short: 'VOTE', owner: '项目级功能管理', description: '综合多个 ECU 的网络与功能状态，决定正常或降级可用。' },
    ],
    flows: [
      { from: 'ignition', to: 'gateway', label: 'wakeup' },
      { from: 'ignition', to: 'powertrain', label: 'wakeup' },
      { from: 'gateway', to: 'pt-can', label: 'ComM / Nm' },
      { from: 'powertrain', to: 'pt-can', label: 'Nm / PDU' },
      { from: 'chassis', to: 'pt-can', label: 'Nm / PDU' },
      { from: 'gateway', to: 'body-can', label: 'ComM / Nm' },
      { from: 'body', to: 'body-can', label: 'Nm / PDU' },
      { from: 'pt-can', to: 'availability', label: 'domain ready' },
      { from: 'body-can', to: 'availability', label: 'domain ready' },
    ],
    steps: [
      { id: 1, title: '车辆唤醒源有效', api: 'EcuM_CheckWakeup', actors: ['ignition'], description: 'KL15/网络唤醒只提供条件，各 ECU 仍分别验证并进入自身 STARTUP。', changes: { ignition: 'ready' } },
      { id: 2, title: '多个 ECU 独立复位', api: 'Reset_Handler → EcuM_Init', actors: ['gateway', 'powertrain', 'chassis', 'body'], description: '四个 MCU 并行执行基础代码和各自的 EcuM 启动前期。', changes: { gateway: 'active', powertrain: 'active', chassis: 'active', body: 'active' } },
      { id: 3, title: '网关先建立基础通信', api: 'StartOS / BswM_Init', actors: ['gateway'], description: '网关先完成本地 OS 与通信栈基础初始化，但尚不能假定其他 ECU 已在线。', changes: { gateway: 'ready' } },
      { id: 4, title: '动力与底盘请求通信', api: 'ComM_RequestComMode(FULL_COM)', actors: ['powertrain', 'chassis', 'pt-can'], description: '请求与实际模式分离；CanSM/CanIf/CanDrv 异步推动 PT-CAN 就绪。', changes: { powertrain: 'ready', chassis: 'ready', 'pt-can': 'active' } },
      { id: 5, title: '车身 ECU 加入网络', api: 'CanNm_NetworkRequest', actors: ['body', 'body-can'], description: 'Body ECU 完成本地启动并通过 Nm 参与 Body-CAN 生命周期。', changes: { body: 'ready', 'body-can': 'active' } },
      { id: 6, title: '两个网络簇收敛', api: 'ComM_BusSM_ModeIndication', actors: ['pt-can', 'body-can'], description: '网关看到的是各网段实际通信状态和 Nm 协调结果，而不是远端 EcuM 内部状态。', changes: { 'pt-can': 'online', 'body-can': 'online' } },
      { id: 7, title: '网关开放跨网段路由', api: 'BswM_PduGroupSwitch', actors: ['gateway', 'pt-can', 'body-can'], description: '只有通信与项目门控满足后，PduR/Com 路由和 I-PDU 组才被放行。', changes: { gateway: 'online', powertrain: 'online', chassis: 'online', body: 'online' } },
      { id: 8, title: '汇总车辆级功能可用性', api: 'VehicleModeManager_Update', actors: ['availability'], description: '车辆功能根据各 ECU 的 ready/timeout 结果进入正常或降级模式。', changes: { availability: 'online' } },
    ],
    concepts: [
      { title: '独立故障域', text: '每个 ECU 可独立重启、Bus-Off 或降级；不能用一个全局启动游标描述真实车辆。' },
      { title: '管理分层', text: 'EcuM 管本 ECU 生命周期，ComM/CanSM/Nm 管通信与网络状态，网关/功能管理汇总车辆级可用性。' },
      { title: '请求 ≠ 实际', text: '远端 ECU 在线必须由报文、Nm、超时和功能握手确认，不能从本地 API 返回值推断。' },
    ],
    fault: {
      at: 5,
      label: 'Body ECU 无 NM 响应',
      reason: 'Body ECU 未在窗口内加入 Body-CAN；车辆功能以降级模式继续，网关不得伪造远端已就绪。',
      mode: 'degraded',
      lockedNodes: ['body'],
      changes: { body: 'error' },
    },
    references: [],
  }),
  profile({
    id: 'multi-core',
    label: '多核启动',
    caption: 'ONE ECU · MULTI-CORE OS / PARTITIONS',
    summary: '在同一个三核 MCU 内，由主核建立共享基础条件、启动从核，并通过 OS-Application、SchM、IOC、Spinlock 与启动屏障协调并行执行。',
    distinction: '多核仍是一个 ECU：共享部分硬件、镜像与配置，但各核拥有自己的 OS 运行数据、任务和中断归属；它不同于通过 CAN 连接的多个 ECU。',
    groups: [
      { id: 'cores', label: '处理器核', caption: 'ONE MCU / THREE CORES', nodes: ['core0', 'core1', 'core2'] },
      { id: 'os', label: 'OS 分区', caption: 'OS-APPLICATION OWNERSHIP', nodes: ['master-os', 'safety-os', 'comm-os'] },
      { id: 'coordination', label: '核间协调', caption: 'BARRIER / IOC / SPINLOCK', nodes: ['barrier', 'ioc', 'spinlock'] },
      { id: 'functions', label: '功能放行', caption: 'RTE EVENTS', nodes: ['safety-app', 'comm-app'] },
    ],
    nodes: [
      { id: 'core0', label: 'Core 0 · Master', short: 'C0', owner: '启动主核', description: '执行复位入口、共享时钟/内存初始化，并在 StartOS 前请求启动其他 AUTOSAR 核。' },
      { id: 'core1', label: 'Core 1 · Safety', short: 'C1', owner: '安全功能核', description: '拥有独立栈、OS 运行数据、任务与中断归属。' },
      { id: 'core2', label: 'Core 2 · Comms', short: 'C2', owner: '通信功能核', description: '承载通信相关 OS-Application 和周期处理。' },
      { id: 'master-os', label: 'Master OS-App', short: 'OS0', owner: 'Core 0', description: '承载共享初始化协调和主核任务。' },
      { id: 'safety-os', label: 'Safety OS-App', short: 'OS1', owner: 'Core 1', description: '隔离安全任务、资源和 Category 2 ISR。' },
      { id: 'comm-os', label: 'Comms OS-App', short: 'OS2', owner: 'Core 2', description: '承载通信 BSW 分区和相关任务。' },
      { id: 'barrier', label: 'Startup Barrier', short: 'SYNC', owner: '项目启动协调', description: '共享配置发布前确认所有必需核达到一致的启动检查点。' },
      { id: 'ioc', label: 'IOC / SchM Proxy', short: 'IOC', owner: '核间通信', description: '为跨 OS-Application 或跨核数据/服务交互提供显式通道。' },
      { id: 'spinlock', label: 'Spinlock', short: 'LOCK', owner: '共享资源保护', description: '保护短小共享资源；忙等意味着必须控制持锁时间和顺序。' },
      { id: 'safety-app', label: 'Safety Runnables', short: 'APP1', owner: 'Core 1 / RTE', description: '启动屏障通过后放行的安全相关周期事件。' },
      { id: 'comm-app', label: 'Communication Tasks', short: 'APP2', owner: 'Core 2 / SchM', description: '通信主函数与应用事件按配置在 Core 2 执行。' },
    ],
    flows: [
      { from: 'core0', to: 'core1', label: 'StartCore(1)' },
      { from: 'core0', to: 'core2', label: 'StartCore(2)' },
      { from: 'core0', to: 'master-os', label: 'StartOS' },
      { from: 'core1', to: 'safety-os', label: 'StartOS' },
      { from: 'core2', to: 'comm-os', label: 'StartOS' },
      { from: 'master-os', to: 'barrier', label: 'ready vote' },
      { from: 'safety-os', to: 'barrier', label: 'ready vote' },
      { from: 'comm-os', to: 'barrier', label: 'ready vote' },
      { from: 'safety-os', to: 'ioc', label: 'IocSend' },
      { from: 'comm-os', to: 'ioc', label: 'IocReceive' },
      { from: 'spinlock', to: 'ioc', label: 'shared state' },
      { from: 'barrier', to: 'safety-app', label: 'release' },
      { from: 'barrier', to: 'comm-app', label: 'release' },
    ],
    steps: [
      { id: 1, title: '主核接管复位入口', api: 'GetCoreID → Core0', actors: ['core0'], description: 'Core 0 建立最小栈、向量与错误处理，其余核仍保持复位/等待。', changes: { core0: 'active' } },
      { id: 2, title: '初始化共享时钟与内存', api: 'Mcu_InitClock / SharedRam_Init', actors: ['core0', 'spinlock'], description: '只由约定的主核初始化共享硬件，避免多个核重复写寄存器。', changes: { core0: 'ready', spinlock: 'ready' } },
      { id: 3, title: '在 StartOS 前启动从核', api: 'StartCore(1) / StartCore(2)', actors: ['core0', 'core1', 'core2'], description: '主核请求启动从核；每个成功启动的核随后都要进入自己的 StartOS 路径。', changes: { core1: 'active', core2: 'active' } },
      { id: 4, title: '各核启动 AUTOSAR OS', api: 'StartOS(AppMode)', actors: ['master-os', 'safety-os', 'comm-os'], description: '多个核共享配置和大量代码，但使用各自的 OS 运行数据结构。', changes: { core1: 'ready', core2: 'ready', 'master-os': 'active', 'safety-os': 'active', 'comm-os': 'active' } },
      { id: 5, title: '建立 OS-Application 归属', api: 'StartupHook / InitTask', actors: ['master-os', 'safety-os', 'comm-os'], description: '任务、ISR、资源与内存区按 OS-Application 和核进行配置与保护。', changes: { 'master-os': 'ready', 'safety-os': 'ready', 'comm-os': 'ready' } },
      { id: 6, title: '建立跨分区通信代理', api: 'SchM_Send / IocSend', actors: ['ioc', 'spinlock'], description: '跨核 BSW 或 SWC 交互使用 SchM/IOC 等显式机制，避免直接共享未保护变量。', changes: { ioc: 'ready', spinlock: 'ready' } },
      { id: 7, title: '等待必需核启动屏障', api: 'StartupBarrier_WaitAll', actors: ['barrier', 'master-os', 'safety-os', 'comm-os'], description: '共享配置和功能放行前确认所有必需核都到达约定检查点。', changes: { barrier: 'ready' } },
      { id: 8, title: '验证 IOC 与锁顺序', api: 'IocSend / GetSpinlock', actors: ['ioc', 'spinlock'], description: '通过教学自检确认核间通道、数据所有权和锁顺序均可用。', changes: { ioc: 'online', spinlock: 'online' } },
      { id: 9, title: '按核放行 RTE 与 BSW 周期事件', api: 'Rte_Start / SchM_StartTiming', actors: ['safety-app', 'comm-app'], description: '把安全 runnable 与通信 MainFunction 放到配置的核和 OS-Application 中运行。', changes: { 'safety-app': 'online', 'comm-app': 'online' } },
    ],
    concepts: [
      { title: '主核职责', text: '共享硬件通常由约定主核初始化；StartCore 应发生在 StartOS 之前，成功启动的核随后调用 StartOS。' },
      { title: '核间通信', text: 'IOC 支持同核或跨核 OS-Application 通信；BSW 跨分区还可由 SchM 生成代理。' },
      { title: '共享资源', text: 'Spinlock 是忙等机制，应保持临界区短小、顺序一致，并避免拿锁后等待慢速外设。' },
    ],
    fault: {
      at: 3,
      blockAt: 7,
      label: 'Core 2 启动超时',
      reason: 'Core 2 未到达启动检查点；屏障阻止通信分区和依赖它的功能被错误放行。',
      mode: 'degraded',
      lockedNodes: ['core2', 'comm-os'],
      changes: { core2: 'error' },
      blockChanges: { barrier: 'error', 'comm-os': 'error' },
    },
    references: [
      { label: 'AUTOSAR OS', url: 'https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_OS.pdf' },
      { label: 'ECU State Manager', url: 'https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_ECUStateManager.pdf' },
      { label: 'BSW Distribution Guide', url: 'https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_BSWDistributionGuide.pdf' },
    ],
  }),
]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const profileById = new Map(SYSTEM_LAB_PROFILES.map((item) => [item.id, item]));
const scenarioIds = new Set(SYSTEM_LAB_SCENARIOS.map((item) => item.id));
const terminalStates = new Set(['complete', 'degraded', 'blocked']);

export function getSystemLabProfile(profileId) {
  const result = profileById.get(profileId);
  if (!result) throw new RangeError(`Unknown system lab profile: ${profileId}`);
  return result;
}

export class SystemArchitectureSimulator {
  constructor(profileId = 'cdd', scenarioId = 'normal') {
    this._profileId = profileId;
    this._scenarioId = scenarioId;
    this._assertConfiguration();
    this.reset();
  }

  _assertConfiguration() {
    getSystemLabProfile(this._profileId);
    if (!scenarioIds.has(this._scenarioId)) throw new RangeError(`Unknown system lab scenario: ${this._scenarioId}`);
  }

  get profile() {
    return getSystemLabProfile(this._profileId);
  }

  reset() {
    this._cursor = 0;
    this._status = 'idle';
    this._blockReason = '';
    this._degradedReason = '';
    this._lockedNodes = new Set();
    this._nodeStates = Object.fromEntries(this.profile.nodes.map((node) => [node.id, 'waiting']));
    this._logs = [];
    return this.getSnapshot();
  }

  selectProfile(profileId) {
    getSystemLabProfile(profileId);
    this._profileId = profileId;
    this._scenarioId = 'normal';
    return this.reset();
  }

  selectScenario(scenarioId) {
    if (!scenarioIds.has(scenarioId)) throw new RangeError(`Unknown system lab scenario: ${scenarioId}`);
    this._scenarioId = scenarioId;
    return this.reset();
  }

  _applyChanges(changes = {}, force = false) {
    for (const [nodeId, status] of Object.entries(changes)) {
      if (!(nodeId in this._nodeStates)) throw new RangeError(`Unknown system lab node: ${nodeId}`);
      if (!force && this._lockedNodes.has(nodeId)) continue;
      this._nodeStates[nodeId] = status;
    }
  }

  step() {
    if (terminalStates.has(this._status)) return this.getSnapshot();
    const step = this.profile.steps[this._cursor];
    if (!step) return this.getSnapshot();

    for (const [nodeId, status] of Object.entries(this._nodeStates)) {
      if (status === 'active' && !this._lockedNodes.has(nodeId)) this._nodeStates[nodeId] = 'ready';
    }
    this._applyChanges(step.changes);
    this._cursor += 1;
    this._status = 'running';
    this._logs.push({ index: this._cursor, level: 'info', title: step.title, api: step.api });

    const fault = this._scenarioId === 'fault' ? this.profile.fault : null;
    if (fault && fault.at === this._cursor) {
      for (const nodeId of fault.lockedNodes ?? []) this._lockedNodes.add(nodeId);
      this._applyChanges(fault.changes, true);
      this._degradedReason = fault.reason;
      this._logs.push({ index: this._cursor, level: 'error', title: fault.label, api: fault.reason });
      if (fault.mode === 'blocked' && !fault.blockAt) {
        this._status = 'blocked';
        this._blockReason = fault.reason;
      }
    }

    if (fault?.blockAt === this._cursor) {
      this._applyChanges(fault.blockChanges, true);
      this._status = 'blocked';
      this._blockReason = fault.reason;
    } else if (this._cursor === this.profile.steps.length && this._status !== 'blocked') {
      this._status = this._degradedReason ? 'degraded' : 'complete';
    }
    return this.getSnapshot();
  }

  seek(cursor) {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.profile.steps.length) throw new RangeError(`Invalid system lab cursor: ${cursor}`);
    this.reset();
    while (this._cursor < cursor && !terminalStates.has(this._status)) this.step();
    return this.getSnapshot();
  }

  runToEnd() {
    while (!terminalStates.has(this._status)) this.step();
    return this.getSnapshot();
  }

  getSnapshot() {
    const currentStep = this._cursor ? this.profile.steps[this._cursor - 1] : null;
    return clone({
      profileId: this._profileId,
      scenarioId: this._scenarioId,
      cursor: this._cursor,
      status: this._status,
      nodeStates: this._nodeStates,
      currentStep,
      nextStep: this.profile.steps[this._cursor] ?? null,
      blockReason: this._blockReason,
      degradedReason: this._degradedReason,
      logs: this._logs,
      progress: this.profile.steps.length ? this._cursor / this.profile.steps.length : 1,
    });
  }
}
