import { MODULES, PHASES, STEPS } from './model.mjs';

export const ARCHITECTURE_FLOWS = Object.freeze([
  {
    id: 'startup-control',
    label: '启动控制链',
    description: '从硬件复位进入 EcuM/OS，再由 SchM、BswM 与 RTE 逐步接管软件运行。',
    modules: ['power', 'mcu', 'ecum', 'os', 'schm', 'bswm', 'rte'],
  },
  {
    id: 'driver-bringup',
    label: '驱动初始化链',
    description: 'EcuM 与项目初始化代码按配置装载 MCAL，先建立时钟、引脚和外设基础能力。',
    modules: ['ecum', 'mcu', 'port', 'dio', 'adc', 'pwm', 'gpt', 'spi', 'candrv', 'wdg', 'fls'],
  },
  {
    id: 'communication-mode',
    label: '通信模式链',
    description: 'BswM 放开通信许可，ComM 提交模式请求，CanSM 推动控制器状态，Nm 参与网络生命周期。',
    modules: ['bswm', 'comm', 'cansm', 'nm', 'canif', 'candrv'],
  },
  {
    id: 'application-data',
    label: '应用通信数据链',
    description: 'SWC 通过 RTE 交换数据，Com 打包信号，PduR 路由 I-PDU，CanIf/CanDrv 完成总线发送。',
    modules: ['sensor', 'rte', 'controller', 'actuator', 'com', 'pdur', 'canif', 'candrv'],
  },
  {
    id: 'diagnostic',
    label: 'UDS 诊断链',
    description: 'CAN 帧经 CanIf、CanTp 与 PduR 到达 Dcm；Dcm 执行服务并按需访问 Dem 等后端。',
    modules: ['candrv', 'canif', 'cantp', 'pdur', 'dcm', 'dem'],
  },
  {
    id: 'persistent-storage',
    label: '持久化存储链',
    description: 'NvM 管理逻辑块与异步作业，MemIf 屏蔽设备差异，Fee/Fls 落到 Flash。',
    modules: ['nvm', 'memif', 'fee', 'fls'],
  },
  {
    id: 'watchdog',
    label: '看门狗监督链',
    description: 'WdgM 监督实体与检查点，经 WdgIf 控制底层 Wdg；各层职责不能混为一次喂狗调用。',
    modules: ['wdgm', 'wdgif', 'wdg'],
  },
  {
    id: 'sensor-input',
    label: '传感器输入链',
    description: 'ADC 采样经 IoHwAb 隐藏通道细节，再由 RTE 交给 Sensor SWC。',
    modules: ['adc', 'iohwab', 'rte', 'sensor'],
  },
  {
    id: 'actuator-output',
    label: '执行器输出链',
    description: '控制结果经 RTE 与 Actuator SWC 下发，IoHwAb 将逻辑量映射到 PWM 等硬件通道。',
    modules: ['controller', 'rte', 'actuator', 'iohwab', 'pwm'],
  },
  {
    id: 'fault-observation',
    label: '错误与故障观测链',
    description: 'Det 面向开发期错误，Dem 管理诊断事件，Logger SWC 只承担本实验的可视化与教学日志。',
    modules: ['det', 'dem', 'logger'],
  },
  {
    id: 'project-extension',
    label: '项目扩展边界',
    description: 'CDD 与板级集成代码用于标准栈难以覆盖的硬件能力，但不应绕过 RTE/BSW 的既有边界。',
    modules: ['mcu', 'iohwab', 'cdd', 'rte'],
  },
]);

const MODULE_INSIGHTS = Object.freeze({
  ecum: {
    startupRole: '建立 ECU 启动骨架，跨越 OS 启动前后的执行上下文，并把后续策略交给配置和 BswM。',
    runtimeRole: '进入 RUN 后负责 ECU 生命周期与关机/唤醒相关协调，而不是承载应用算法。',
    caution: '不要把某个项目的 EcuM 启动顺序误认为所有 AUTOSAR 版本唯一合法的固定顺序。',
  },
  bswm: {
    startupRole: '接收模式请求与模块通知，按规则执行初始化、通信许可和应用放行动作。',
    runtimeRole: '持续仲裁模式条件；它是策略与动作编排者，不是硬件驱动。',
    caution: '规则动作可能异步，只看到请求返回 E_OK 不能证明目标模式已经到达。',
  },
  schm: {
    startupRole: '在 OS 已运行后建立 BSW MainFunction 的调度与临界区协调。',
    runtimeRole: '按配置节拍触发 BSW 周期处理，和应用任务调度属于不同关注面。',
    caution: 'SchM_Start、SchM_Init 与 SchM_StartTiming 在本实验中被刻意拆开以显示生命周期差异。',
  },
  os: {
    startupRole: 'StartOS 后接管控制流，通过自动启动任务承载 StartupTwo 等后续初始化。',
    runtimeRole: '提供任务、事件、资源、中断与调度语义。',
    caution: 'StartOS 通常不会像普通函数一样返回 main 后继续执行下一行。',
  },
  rte: {
    startupRole: '先建立 RTE 框架与初始化容器，再按项目门控放开周期事件。',
    runtimeRole: '连接 SWC 端口、运行实体与 BSW 服务，是生成式集成边界。',
    caution: 'Rte_Start 与应用 runnable 真正开始周期执行不一定发生在同一个时刻。',
  },
  nvm: {
    startupRole: '初始化管理状态并发起 ReadAll，等待 MainFunction/底层存储异步推进后再消费数据。',
    runtimeRole: '管理逻辑块、RAM/NV 镜像、冗余、CRC 与异步作业状态。',
    caution: 'NvM_ReadAll 返回只表示请求已提交，不表示所有块已经恢复完成。',
  },
  comm: {
    startupRole: '在通信许可开放后提交目标模式请求，并等待 BusSM 反馈实际状态。',
    runtimeRole: '汇总用户通信需求并协调 NO/SILENT/FULL communication。',
    caution: 'requested 与 actual 必须分开观察。',
  },
  cansm: {
    startupRole: '把 ComM 的抽象模式请求异步转换为 CAN 控制器/收发器状态变化。',
    runtimeRole: '处理启动、关闭、Bus-Off 恢复和模式通知。',
    caution: '控制器 ONLINE 不等于所有应用 PDU 已获准发送。',
  },
  nm: {
    startupRole: '通信栈初始化时建立网络管理接口；本实验尚未展开真实 CanNm 状态机。',
    runtimeRole: '真实项目中协调网络请求、保持唤醒与进入 Bus-Sleep 的时机。',
    caution: 'CAN ID 和周期报文本身不能证明它是 NM PDU，必须核对 CanNm/CanIf 配置引用。',
  },
  dcm: {
    startupRole: '在诊断栈初始化后建立服务分派、会话、安全与时序上下文。',
    runtimeRole: '接收 UDS 请求，检查长度/会话/安全条件，并调用 Dem、NvM 或项目服务。',
    caution: 'Dcm ready 仍依赖 CanTp/PduR/CanIf 与实际总线通信模式才能端到端诊断。',
  },
  cantp: {
    startupRole: '随通信栈装载 ISO-TP 通道与 N-SDU 配置。',
    runtimeRole: '对长诊断消息执行 SF/FF/FC/CF 分段、流控与重组。',
    caution: 'CAN FD 只提高单帧容量；超过容量时仍需要 ISO-TP 多帧传输。',
  },
  dem: {
    startupRole: '初始化事件、DTC、状态位和存储相关上下文。',
    runtimeRole: '接收事件报告、维护 DTC 状态，并向 Dcm 提供诊断数据。',
    caution: 'Det 的开发错误与 Dem 的诊断事件属于不同错误域。',
  },
  canif: {
    startupRole: '建立上层 PDU 与底层 CAN Hardware Object/控制器之间的配置映射。',
    runtimeRole: '承接收发、控制器模式通知与 PDU 模式门控。',
    caution: 'CanIf 是接口与映射层，不负责 UDS 服务语义或网络模式策略。',
  },
  wdgm: {
    startupRole: '装载监督实体、检查点与模式配置，并在允许时进入监督状态。',
    runtimeRole: '判断 Alive/Deadline/Logical supervision 结果并触发恢复策略。',
    caution: 'WdgM、WdgIf 和 Wdg 分别负责监督、抽象与硬件驱动。',
  },
  cdd: {
    startupRole: '作为项目扩展点参与板级初始化或特殊硬件控制。',
    runtimeRole: '承载无法合理映射到标准 MCAL/ECU Abstraction 的复杂驱动需求。',
    caution: 'CDD 不是任意跨层访问的通行证，接口、时序和安全边界仍应明确。',
  },
});

const LAYER_INSIGHTS = Object.freeze({
  hardware: {
    runtimeRole: '提供软件运行所依赖的物理资源与复位入口。',
    caution: '硬件状态必须通过驱动和抽象层暴露，应用不应假定寄存器细节。',
  },
  mcal: {
    runtimeRole: '直接面向微控制器外设寄存器，并向上提供标准化驱动接口。',
    caution: '初始化顺序受时钟、引脚、控制器模式和生成配置约束。',
  },
  abstraction: {
    runtimeRole: '屏蔽设备实例和底层实现差异，为服务层或 RTE 提供稳定接口。',
    caution: '抽象层解决硬件差异，不应复制上层状态机与业务策略。',
  },
  service: {
    runtimeRole: '提供系统级状态机、通信、诊断、存储或监督服务。',
    caution: '许多服务通过 MainFunction 和通知异步推进，API 返回不等于动作完成。',
  },
  rte: {
    runtimeRole: '连接 SWC 与 BSW 服务并调度配置的 runnable 事件。',
    caution: 'RTE 接口和初始化函数通常由工具生成，项目代码不应随意手写替代。',
  },
  app: {
    runtimeRole: '实现车辆功能算法，通过 RTE 端口访问数据与服务。',
    caution: 'SWC 不应直接依赖具体 MCAL 通道或绕过 RTE 访问底层。',
  },
});

const moduleById = new Map(MODULES.map((module) => [module.id, module]));

export function getStepRole(step, moduleId) {
  if (step.caller === moduleId) return '发起调用';
  if (step.target === moduleId) return '主要目标';
  return '协同参与';
}

export function getModuleGuide(moduleId) {
  const module = moduleById.get(moduleId);
  if (!module) throw new RangeError(`Unknown module: ${moduleId}`);

  const steps = STEPS
    .filter((step) => step.modules.includes(moduleId))
    .map((step) => ({ ...step, role: getStepRole(step, moduleId), phaseInfo: PHASES.find((phase) => phase.id === step.phase) }));
  const flows = ARCHITECTURE_FLOWS.filter((flow) => flow.modules.includes(moduleId));
  const upstream = new Set();
  const downstream = new Set();

  for (const step of steps) {
    if (step.target === moduleId && moduleById.has(step.caller)) upstream.add(step.caller);
    if (step.caller === moduleId && moduleById.has(step.target)) downstream.add(step.target);
  }
  for (const flow of flows) {
    const index = flow.modules.indexOf(moduleId);
    if (index > 0) upstream.add(flow.modules[index - 1]);
    if (index >= 0 && index < flow.modules.length - 1) downstream.add(flow.modules[index + 1]);
  }

  const layerInsight = LAYER_INSIGHTS[module.layer] ?? LAYER_INSIGHTS.service;
  const specific = MODULE_INSIGHTS[moduleId] ?? {};
  const firstStep = steps[0] ?? null;
  const lastStep = steps.at(-1) ?? null;
  const startupRole = specific.startupRole ?? (firstStep
    ? `首次在第 ${firstStep.id} 步“${firstStep.title}”出现，并以“${firstStep.role}”身份参与启动。`
    : '本教学配置未把该模块拆成独立启动步骤，它通过相邻模块或项目集成代码间接参与。');

  return {
    module,
    steps,
    flows,
    upstream: [...upstream].map((id) => moduleById.get(id)),
    downstream: [...downstream].map((id) => moduleById.get(id)),
    firstStep,
    lastStep,
    startupRole,
    runtimeRole: specific.runtimeRole ?? layerInsight.runtimeRole,
    caution: specific.caution ?? layerInsight.caution,
  };
}
