# Autosar CP Architecture Framework Laboratory

一个零第三方运行时依赖、直接在本机运行的 AUTOSAR Classic Platform 交互式学习实验室。沿着 **7 个阶段、42 个教学步骤**观察控制权从硬件到 EcuM、OS、BswM，最终到 RTE 和应用的交接；再通过完整的 UDS 与系统架构工作区学习 DCM、刷写、CDD、多 ECU 协同和多核启动。

页面顶部提供三个同级工作区，切换时会保留各自的实验状态：

- **启动流程**：42 步启动动画、故障场景、断点、日志、任务调度与 CAN 报文。
- **UDS 诊断与刷写**：会话、安全访问、DID、DTC、ISO-TP、教学刷写和虚构 OEM 私有服务。
- **系统架构**：CDD、多 ECU、多核启动、实例所有权、同步关系和故障门控。

## 环境要求

- Node.js 20 或更新版本。
- 支持 ES modules、Canvas 与原生 `dialog` 的现代浏览器。
- 不需要商业 AUTOSAR 工具、数据库、云服务或第三方 npm 依赖。

## 立即运行

```powershell
git clone https://github.com/yeyue1/Autosar-CP-Architecture-Framework-Laboratory.git
cd Autosar-CP-Architecture-Framework-Laboratory
npm start
```

浏览器打开 [http://127.0.0.1:4173/](http://127.0.0.1:4173/)，选择顶部工作区即可开始。

Windows 也可以直接双击仓库中的 **[start.cmd](start.cmd)**。项目没有第三方包，因此不需要先执行 `npm install`。

保持终端开启；`Ctrl+C` 停止服务。若 4173 端口已被占用，可以启动另一个本地实例：

```powershell
node server.mjs --port 4174 --open
```

不要直接双击 `index.html`，浏览器需要通过本地 HTTP 服务加载 ES 模块。

## 可以做什么

- 播放、暂停、单步、回退、重新上电和 0.5×–8× 播放速度。
- 用进度条或七阶段导航确定性回放；用「步骤目录」直接定位任意一步。
- 在下一步或任意目录项上设置**执行前断点**。暂停后继续可跨过该断点一次；手动单步不会再次卡在同一断点。
- 查看分层架构的模块高亮、模块学习卡、中文解释和示例 C 伪代码；展开模块架构讲解器，沿启动控制、通信、诊断、存储、看门狗和 I/O 路径钻取上下游关系。
- 通过顶层标签在 **启动流程 / UDS 诊断与刷写 / 系统架构** 三个完整工作区之间切换，切换时保留各实验状态。
- 在系统架构工作区切换 **CDD 深入 / 多 ECU 协同 / 多核启动**，单步或播放实例状态、依赖链、启动屏障和故障门控。
- 同时观察 EcuM 教学阶段、OS/RTE 状态、NvM 作业与数据来源、通信请求与实际模式。
- 筛选启动日志、查看模拟周期任务时序、应用信号及教学 CAN 报文。
- 导出当前场景快照、日志和总线记录为 JSON。
- 在内置学习指南中练习异步初始化、状态门控和版本差异题目。
- 在 UDS 实验台发送十六进制请求，学习 `0x10/0x14/0x19/0x22/0x27/0x2E/0x31/0x34/0x36/0x37/0x3E`、正负响应和 NRC。
- 展开经典 CAN 上的 ISO-TP `SF/FF/FC/CF`，并用 Bus-Off 场景区分 UDS 负响应和传输失败。
- 用两份内置教学镜像练习 `RequestDownload → TransferData → RequestTransferExit → CRC32 → 双分区激活`，可单步或自动执行。
- 试验三条完全虚构的 OEM 私有服务，观察自定义语义如何继续受会话、安全、顺序和范围检查约束。

### 五个场景

| 场景 | 应观察到什么 |
| --- | --- |
| 正常启动 | 满足前置条件后进入 RUN；周期任务和示例报文继续运行 |
| PLL 锁定失败 | 时钟前提不满足，启动在进入 OS 前停止；回放不能跳过故障 |
| NvM 读取偏慢 | 发起请求不等于完成；pending 等待导致更长的虚拟启动时间 |
| NvM CRC 失败 | 记录告警、明确数据来自 ROM 默认值，再按本示例策略继续 |
| CAN Bus-Off | 应用可以 RUN，但 ComM 实际模式停在 SILENT_COM；不会伪造成功发送帧 |

切换场景会清空当前运行并重新上电。断点保留，方便在同一位置比较不同实验；在步骤目录中可以清除全部断点。刷新网页则开始一个全新会话。

### 快捷键

`Space` 播放/暂停 · `→` 单步（RUN 后推进 10ms）· `←` 回退一个启动步骤 · `B` 下一步断点 · `R` 重新上电 · `Esc` 关闭弹窗。

输入框、下拉框、工作区标签和辅助弹窗有自己的键盘行为，不抢占这些控件的输入；工作区标签支持方向键、Home 和 End。

## 学习路线

1. 先用正常场景走通一次，找出 `StartOS` 这一控制权边界。
2. 用断点比较 `EcuM_StartupTwo`、SchM/BswM 启动、`NvM_ReadAll`、RTE 启动时序。
3. 对照慢读和 CRC 场景，说明「请求受理」「数据就绪」「使用默认值」的区别。
4. 对照正常与 Bus-Off 场景，区分网络许可、请求模式和实际模式。
5. 打开「系统架构」，比较“多个独立 ECU”和“一个 ECU 内多个核心”的所有权差异。
6. 修改模型中的一项参数，运行自动化测试，再观察其影响。

详细解释见 **[启动学习指南](docs/learning-guide.md)**、**[UDS 诊断实验指南](docs/uds-lab.md)** 和 **[CDD、多 ECU 与多核实验指南](docs/system-architecture-lab.md)**；每项重要约束的官方出处与版本差异见 **[来源与复现边界](docs/sources.md)**。

## 验证与命令行仿真

```powershell
# 语法、目录和模型完整性检查
npm run check

# Node 内建测试：启动、回放、故障、播放控制、本地服务边界
npm test

# 一次执行上述验证
npm run verify

# 不打开浏览器，在终端输出完整仿真记录
npm run trace -- --scenario normal --duration 250

# 保存到明确指定的文件
node scripts/export-trace.mjs --scenario nvm-crc --duration 250 --out .runtime/nvm-crc.json
```

`--duration` 是进入 RUN 后的额外虚拟毫秒，不是墙钟运行时长。PLL 故障会返回阻塞快照，不会强行完成后续步骤。界面中的运行记录采用有界缓冲区，长时间运行不会保留无限历史；需要保留某一刻，请及时导出。

## 源码怎么读

| 文件 | 作用 |
| --- | --- |
| [src/model.mjs](src/model.mjs) | 七阶段、42 步的解释与伪代码、模块定义、场景、任务参数 |
| [src/module-guide.mjs](src/module-guide.mjs) | 从模块与启动步骤派生生命周期、上下游关系和跨层软件路径 |
| [src/system-lab.mjs](src/system-lab.mjs) | CDD、多 ECU、多核 profile 及可回放、可故障注入的独立状态机 |
| [src/engine.mjs](src/engine.mjs) | 离散状态转移、故障策略、虚拟任务调度、信号与报文 |
| [src/player.mjs](src/player.mjs) | 播放时间与 ECU 时间分离、断点、暂停和回放 |
| [src/uds.mjs](src/uds.mjs) | UDS 会话/安全/DID/DTC、刷写/分区状态机、虚构 OEM 服务与 ISO-TP 分帧 |
| [src/app.mjs](src/app.mjs) | DOM 交互、模块高亮、任务图、UDS 实验台和导出 |
| [index.html](index.html) / [styles.css](styles.css) | 无框架界面和响应式布局 |
| [server.mjs](server.mjs) | 只绑定本机地址、白名单路径的静态 HTTP 服务 |
| [tests](tests/) | Node 内置测试，不依赖外部测试框架 |

编辑后刷新浏览器加载新版本。模型和视图分离，可以先在命令行验证新场景，再接入界面。没有第三方运行时依赖、云服务、遥测或自动上传。

## 重要边界

这是**教学级行为仿真**，不是可烧录到硬件上的 AUTOSAR 工程，也不是 CPU 指令仿真器或商业虚拟 ECU：

- 不执行真实 ECU C 固件，不提供量产 BSW / MCAL / RTE 生成器，不生成 ARXML。
- 不连接物理 CAN，没有 CAN 仲裁、真实中断、硬件寄存器或功能安全认证。
- UDS 使用虚构 DID/DTC、公开玩具 Seed/Key、浏览器内存镜像和简化时间语义，不是诊断一致性测试、真实刷写器或量产安全实现。
- 时间、任务耗时、CPU 占用、传感器值、CAN ID 和错误策略均为示例，不是实测。
- 多 ECU 拓扑、核分配、启动屏障和 CDD 特殊 ASIC 均为教学配置，不是可直接生成的系统描述或 OS 配置。
- STARTUP I / II / RUN 是方便学习的阶段标签，不把现代 Flexible 冒充旧 Fixed 状态机。
- NvM 恢复后再放行业务是本示例的门控策略，不是所有版本/项目通用的唯一顺序。

想进一步落到真实工程时，应基于明确的 MCU、BSW 供应商、OS 和配置工具另建集成环境，并核对对应版本规范。本实验室适合在此之前理解依赖关系和调试思路。
