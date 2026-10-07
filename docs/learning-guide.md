# AUTOSAR 启动实验室：学习指南

这套环境帮助你回答三个问题：**此时谁在执行？下一步依赖什么？请求完成了，还是仅被接收？** 它是基于 AUTOSAR Classic R24-11 / EcuM Flexible 的教学状态仿真，不执行真实 ECU 固件。画面中的 STARTUP I、STARTUP II 和 RUN 是概念阶段标签，不等同于旧 EcuM Fixed 的完整状态机。版本边界和官方资料见[来源说明](sources.md)。

## 建议的学习方式

第一次从复位连续运行一遍，观察七阶段的控制权转移。第二次使用单步，在调用前预测状态变化，再核对日志和模块状态。第三次对比故障场景：重点找“最后一个已完成的前提”，不要只记最后出现的错误。

不要把每一步当成耗时相同的一条机器指令。教学步可能代表 API 调用、异步完成、模式条件成立或一次任务观察；虚拟时间也不是硬件性能测量。

### 用模块架构讲解器反向学习

除了沿时间线正向播放，还可以点击分层架构中的任一模块，再选择「展开软件架构与启动时间线」。讲解器会从当前 `MODULES` 和 42 个 `STEPS` 自动派生该模块首次参与的位置、调用角色、关键 API、直接上下游以及它所在的跨层路径。

推荐先观察四个对照组：

1. `EcuM → OS → SchM → BswM → RTE`：理解控制权如何跨越 `StartOS`。
2. `BswM → ComM → CanSM → CanIf → Can Driver`：区分通信许可、请求和实际模式。
3. `Can Driver → CanIf → CanTp → PduR → Dcm → Dem`：从 CAN 帧追到 UDS 服务和 DTC 后端。
4. `NvM → MemIf → Fee → Fls`：区分逻辑块管理、存储抽象、Flash EEPROM 仿真和底层驱动。

点击架构路径中的相邻模块可以继续钻取；点击启动时间线条目会把主仿真回放到对应步骤。路径是本教学配置的结构化解释，不是声称所有量产 ECU 都必须采用完全相同的模块组合。

### 从单 ECU 主线扩展到系统架构

在页面顶部切换到「系统架构」工作区。当前 42 步单 ECU、单核主线保持不变，系统架构工作区另外提供三个可单步、播放和故障注入的 profile：

1. **CDD 深入**：观察特殊 ASIC、标准 Spi、CDD、SchM/OS、Det/Dem、RTE 与 SWC 的接口边界。
2. **多 ECU 协同**：观察 Gateway、Powertrain、Chassis、Body ECU 如何独立启动，再通过 ComM/CanSM/Nm 与网关路由形成车辆级可用性。
3. **多核启动**：观察 Core 0 共享初始化、`StartCore`、各核 `StartOS`、OS-Application、IOC、Spinlock 与启动屏障。

每种模式都先回答“谁拥有这个状态”，再判断“谁在等待谁”。完整练习和规范边界见 [CDD、多 ECU 与多核启动实验指南](system-architecture-lab.md)。

## 七阶段分别在学什么

| 阶段 | 关键观察点 | 需要能回答的问题 |
| --- | --- | --- |
| 硬件与基础代码 | 复位入口、最小 CPU/栈准备、C 变量初始化 | 为什么进入 EcuM 前就必须能够运行 C 代码？ |
| EcuM 启动前期 | `EcuM_Init`、InitZero、PB 配置、InitOne、时钟 | 哪些初始化不能使用 OS 或尚未确定的配置？ |
| 操作系统启动 | `StartOS`、启动钩子、自动启动任务 | 为什么启动后不是简单回到原来的顺序代码继续执行？ |
| EcuM 启动后期 | `EcuM_StartupTwo`、SchM、BswM | 谁接回控制，谁负责后面的配置化动作？ |
| BSW 基础初始化 | 存储服务、`NvM_ReadAll`、其他 BSW | 哪些数据只是请求读取，哪些已经可用？ |
| RTE 启动与模式切换 | RTE 生命周期、BswM 条件、通信模式 | 已初始化、可调度、允许通信和实际上线是否相同？ |
| 运行模式 | 周期 runnable、BSW 周期函数、报文路径 | 一个应用输出怎样经 RTE 和 BSW 到达总线？ |

分组用于学习，不是规范规定的固定七段；具体 API 所在步骤以当前界面为准。EcuM 的规范骨架见 [§7.3][ecum]，BswM 后续启动的例子见 [§3.3.3][mode-guide]。

## 四条关键依赖

### 1. EcuM 的前后两段不是同一条调用栈的直线延伸

最小 C 环境就绪后进入 `EcuM_Init`；pre-OS 部分准备启动 OS 所需条件。`StartOS` 交出控制，随后由自动启动的 OS 任务以 `EcuM_StartupTwo` 为首个动作接回。InitZero 不使用 post-build 配置；配置确定并校验后才进入 InitOne。pre-OS 不应依赖 Category II 中断。[EcuM §7.3.1–7.3.2][ecum]

post-OS 骨架顺序是：`SchM_Start → BswM_Init → SchM_Init → SchM_StartTiming`。不要仅凭函数名称把 `SchM_Init` 放到 `SchM_Start` 前面。[EcuM §7.3.3][ecum]

### 2. 发起请求，不等于资源就绪

`NvM_ReadAll()` 返回类型是 `void`，它发起多块读取，不同步交付所有数据。要区分 pending、完成和失败，结合周期处理、配置的完成通知，或者 `NvM_GetErrorStatus(0, &status)` 观察整体请求；不能把“函数已经返回”当成“数据已经恢复”。[NvM §8.3.3.1；SWS_NvM_00394][nvm]

还要辨认回调方向：`NvM_JobEndNotification` 是存储底层到 NvM 的通知；NvM 向 BswM 反馈多块作业状态使用的是 `BswM_NvM_CurrentJobMode` 等配置接口。一个底层块读完，不代表整个 ReadAll 已完成。[NvM §8.3.3.6.1、图 9.11][nvm]

PLL 也有类似观察点：`Mcu_InitClock` 启动锁定过程，但不等待锁定完成。使用 PLL 的配置应先通过 `Mcu_GetPllStatus` 确认锁定，再分配 PLL 时钟；未锁定时不能假装切换成功。[MCU §8.3.3–8.3.5][mcu]

### 3. RTE 启动有不同层次

`Rte_Start` 初始化 RTE；生成的 `Rte_Init_<InitContainer>` 调用配置的初始化 runnable 批次；`Rte_StartTiming` 才放开相应的周期与后台事件。`<InitContainer>` 是项目生成的名字，指南里的 `Rte_Init` 是简称。[RTE §5.8.2–5.8.4][rte]

本教学配置让依赖持久数据的业务在数据就绪后运行。这是有意选择的安全学习顺序，不代表所有 AUTOSAR 项目都必须延后整个 RTE。旧 Fixed 甚至可以先启动带 STARTUP 模式的 RTE，再等待 NvM 并完成 InitThree；关键是不要让依赖尚未恢复数据的业务提前使用数据。[Fixed §7.3.4.2][fixed]

### 4. 通信权限、通信请求和实际通信要分开

ComM 初始化后，通道的 `CommunicationAllowed` 默认关闭。放开许可、申请 `COMM_FULL_COMMUNICATION` 和总线真正进入该模式是三件事；申请模式与实际模式可以暂时不同。[ComM SWS_ComM_00884、00092][comm]

`CanSM_RequestComMode` 是异步 API，`E_OK` 表示接收请求。真实状态推进还涉及配置的收发器、控制器模式确认，并经 `ComM_BusSM_ModeIndication` 等接口反馈。CAN 控制器已初始化也不等于所有应用 PDU 已获准发送。[CanSM §7.2.22、§8.3.3、§8.6.1.1][cansm]

## 推荐实验与预期观察

下面是观察任务，不是硬件测试规程；以当前界面实际提供的场景和控制项为准。

1. **正常启动对照。** 在 `StartOS` 和 `EcuM_StartupTwo` 附近暂停，辨认执行上下文变化。记录 SchM/BswM 四个动作的顺序，再核对完整日志。
2. **NvM 的请求与完成。** 在 `NvM_ReadAll` 后单步：先找 pending，再找完成或错误。检查本示例依赖数据的后续步骤是否仍被拦住。若使用缺省值恢复，必须能解释“原数据恢复成功”和“采用缺省值继续”的区别。
3. **时钟前提。** 对照正常与 PLL 故障路径，找出“锁定确认”这个前提。思考：初始化时钟 API 已返回，为什么仍不能把目标时钟标为就绪？
4. **通信模式对照。** 在申请 FULL 后观察请求值与实际值，不要只看模块是否绿色。思考：没有模式确认、权限未放开或应用 PDU 未启用时，发送为什么仍可能不可用？
5. **运行期追踪。** 在运行阶段选取一条示例数据，分别定位应用处理、RTE 交互和 BSW/总线路径。区分应用 runnable 与 `NvM_MainFunction` 等 BSW 周期函数的职责。

对于尚未在界面暴露的条件，可以先作为读日志与时序图的思考题；不要据此认为仿真已覆盖真实总线故障、所有 NvM 恢复策略或所有 OS 调度情况。

## 从启动继续到 UDS 诊断

完成正常启动后，在页面顶部切换到「UDS 诊断与刷写」工作区。它会复用当前 DCM 和 CAN 状态，因此可以先在默认会话读取 VIN，再切换扩展会话、执行教学 Seed/Key、读取或清除 DTC；也可以切换 Bus-Off 场景，验证“无响应”不等于 ECU 返回 NRC。返回其他工作区后，当前诊断会话、历史和刷写进度会被保留。

具体请求、预期响应、ISO-TP 分帧和练习顺序见 [UDS 诊断实验指南](uds-lab.md)。

## Fixed 与 Flexible：不要混着记

| 问题 | 旧 Fixed（R4.3.1，历史对照） | 本项目的 Flexible 教学基线 |
| --- | --- | --- |
| 后续启动组织者 | 固定状态/初始化块流程 | EcuM 完成启动骨架，BswM 按配置规则推进后续流程 |
| InitTwo / InitThree | 有专门 callout；InitThree 面向需要恢复 NvM 数据的模块 | 不能假定现代 EcuM 必须调用这两个旧接口 |
| RUN 的含义 | 固定状态机的一部分 | 本项目的业务模式与可观察运行阶段，不是固定 EcuM 状态机的完整复刻 |
| NvM 与 RTE | 可先启动 RTE、后等待 NvM/推进业务模式 | 示例采用数据门控；具体依赖和失败策略是项目选择 |

对照依据：[历史 Fixed §7.3.3–7.3.5][fixed]、[现代 EcuM §7.3][ecum]、[Mode Management Guide §3.3.3–3.3.4][mode-guide]。不要把历史文档中的表格直接当作当前平台的工程模板。

## 常见误区

- **“看到 42 步就学完了 AUTOSAR。”** 步数是界面的教学粒度；实际工程可能多核、多分区、分阶段初始化，并有更多配置依赖。
- **“所有驱动永远放在同一个 InitBlock。”** 具体位置受硬件、配置和模块依赖影响，不能把示例列表当成唯一答案。[EcuM §7.3.2][ecum]
- **“模块显示就绪，就一定调用过它的 Init。”** DIO 的硬件准备由 Port Driver 完成；MemIf 没有标准 `MemIf_Init`。界面的模块就绪可以表示下层依赖已准备好，不能据模块名机械拼接一个初始化 API。[DIO §7.2][dio]；[MemIf §8.3][memif]
- **“NvM 读失败就必须永久停机，或必须无条件用默认值。”** 两者都不是本仿真可以替整个项目决定的策略；需要区分数据重要性和降级约束。
- **“Dem 永远不需要等 NvM，或永远必须等整个 ReadAll。”** 使用持久诊断块时，使用数据前必须检查其状态；RAM-only 的 Dem 则没有同样的存储依赖。真实项目应明确选择，而不是靠初始化列表猜测。[Dem §7.11.5][dem]
- **“ECU 处于 RUN 就必须每条网络都 FULL。”** 应用可运行与具体网络的需求不同；不能用一条通道的状态代表整个 ECU 的所有业务。[Mode Management Guide §3.3.3–3.3.4][mode-guide]
- **“动画成功意味着真实 ECU 可启动。”** 本项目只验证教学模型；真实工程还需要生成配置、模块集成、目标硬件和实际测试。

下一轮学习，建议围绕一个具体问题读规范：先找到界面上的 API，再查[来源说明](sources.md)中的章节或 SWS 标识，写出它的前提、状态变化、完成条件和失败路径。把这四项说清楚，比背诵一串初始化函数更重要。

[ecum]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_ECUStateManager.pdf
[mode-guide]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_ModeManagementGuide.pdf
[rte]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_RTE.pdf
[nvm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_NVRAMManager.pdf
[mcu]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_MCUDriver.pdf
[comm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_COMManager.pdf
[cansm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_CANStateManager.pdf
[dio]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DIODriver.pdf
[memif]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_MemoryAbstractionInterface.pdf
[dem]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DiagnosticEventManager.pdf
[fixed]: https://www.autosar.org/fileadmin/standards/R4.3.1/CP/AUTOSAR_SWS_ECUStateManagerFixed.pdf
