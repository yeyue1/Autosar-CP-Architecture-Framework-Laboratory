// 中文 ↔ 英文 AUTOSAR 术语同义词组。组内 token 互为近义，
// 每个 token 都必须是 tokenize() 可产生的小写形式（英文整词/子词，中文单字或二元组）。

// 每组：name 为人类可读术语名，tokens 为可互相扩展的 token。
const GROUPS = [
  { name: 'EcuM / ECU 状态管理', tokens: ['ecum', '状态', 'statemanager'] },
  { name: 'BswM / 模式管理', tokens: ['bswm', '模式', 'mode'] },
  { name: 'RTE / 运行时环境', tokens: ['rte', '运行时', 'runtime'] },
  { name: 'DCM / 诊断通信', tokens: ['dcm', '诊断', 'diagnostic', 'uds'] },
  { name: 'DEM / 诊断事件', tokens: ['dem', 'dtc', '故障', '错误', 'fault', 'error', 'event'] },
  { name: 'NvM / 非易失存储', tokens: ['nvm', '非易失', 'nvram', 'persistent'] },
  { name: 'Fee / Flash 模拟 EEPROM', tokens: ['fee', 'eeprom', '模拟'] },
  { name: 'Fls / Flash 驱动', tokens: ['fls', 'flash', '闪存', '扇区', 'sector'] },
  { name: '刷写 / 编程', tokens: ['刷写', '编程', 'programming', 'firmware'] },
  { name: 'ComM / 通信管理', tokens: ['comm', '通讯', '通信', 'communication'] },
  { name: 'CanSM / CAN 状态管理', tokens: ['cansm', 'can状态'] },
  { name: 'CanTp / 传输层', tokens: ['cantp', '传输', 'transport'] },
  { name: 'CanIf / CAN 接口', tokens: ['canif', '接口', 'interface'] },
  { name: 'Can / CAN 总线', tokens: ['can', '总线', 'bus'] },
  { name: 'Com / 信号通信', tokens: ['com', '信号', 'signal'] },
  { name: 'PduR / PDU 路由', tokens: ['pdur', '路由', 'routing'] },
  { name: 'NM / 网络管理', tokens: ['nm', '网络', 'network'] },
  { name: 'OS / 操作系统', tokens: ['os', '操作系统', '调度', 'scheduling'] },
  { name: 'Spinlock / 自旋锁', tokens: ['spinlock', '自旋锁', '锁'] },
  { name: 'IOC / 核间通信', tokens: ['ioc', '核间', 'intercore'] },
  { name: 'XCP / 标定测量', tokens: ['xcp', '标定', 'calibration', 'calibrate'] },
  { name: 'DAQ / 数据采集', tokens: ['daq', '采集', 'measurement'] },
  { name: 'CDD / 复杂驱动', tokens: ['cdd', '复杂', '驱动', 'driver'] },
  { name: 'MCAL / 微控制器抽象', tokens: ['mcal', '微控制器', 'microcontroller'] },
  { name: 'ARXML / 描述文件', tokens: ['arxml', '描述', 'description'] },
  { name: '休眠 / 唤醒', tokens: ['休眠', '唤醒', 'sleep', 'wakeup'] },
  { name: '启动 / 上电', tokens: ['启动', '上电', 'startup', 'boot', 'poweron'] },
  { name: '分区 / 扇区', tokens: ['分区', 'partition', 'bank'] },
  { name: '中断 / ISR', tokens: ['中断', 'interrupt', 'isr'] },
  { name: '周期任务', tokens: ['周期', 'cycle', 'periodic'] },
  { name: '堆栈', tokens: ['堆栈', 'stack', '栈'] },
  { name: '预编译配置', tokens: ['预编译', 'precompile', '变体', 'variant'] },
  { name: '后构建配置', tokens: ['后构建', 'postbuild', '重配置'] },
  { name: '链接时配置', tokens: ['链接', 'linktime'] },
  { name: '看门狗', tokens: ['看门狗', 'watchdog', 'wdt'] },
  { name: '安全 / Safety', tokens: ['安全', 'safety', 'security'] },
  { name: '消息 / PDU', tokens: ['消息', 'message', 'pdu', '报文'] },
  { name: '网关 / 路由节点', tokens: ['网关', 'gateway'] },
  { name: '电压 / 电源', tokens: ['电压', 'voltage', '电源', 'power'] },
  { name: '时钟 / 定时器', tokens: ['时钟', 'clock', 'timer'] },
  { name: '复位 / 重启', tokens: ['复位', 'reset', '重启'] },
  { name: '参数 / 配置', tokens: ['参数', 'parameter', '配置', 'config'] },
  { name: '微控制器 / 芯片', tokens: ['mcu', '单片机', 'chip'] },
  { name: '错误处理 / 降级', tokens: ['降级', 'degrade', 'detect'] },
  { name: '时间 / 时序', tokens: ['时序', 'timing', '时间', 'time'] },
  { name: '内存 / RAM', tokens: ['内存', 'memory', 'ram'] },
];

export const SYNONYM_GROUPS = GROUPS.map((group) => group.tokens.slice());

const TOKEN_INDEX = new Map();
const TOKEN_TERM = new Map();
GROUPS.forEach((group, index) => {
  for (const token of group.tokens) {
    if (!TOKEN_INDEX.has(token)) TOKEN_INDEX.set(token, index);
    if (!TOKEN_TERM.has(token)) TOKEN_TERM.set(token, group.name);
  }
});

/** 返回与 token 同义（同组，不含自身）的 token。 */
export function expandToken(token) {
  if (typeof token !== 'string') return [];
  const index = TOKEN_INDEX.get(token);
  if (index === undefined) return [];
  return GROUPS[index].tokens.filter((item) => item !== token);
}

/** 反查 token 所属术语组的人类可读名，未命中返回 null。 */
export function termOf(token) {
  if (typeof token !== 'string') return null;
  return TOKEN_TERM.get(token) ?? null;
}
