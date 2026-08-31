# CDD、多 ECU 与多核启动实验指南

页面顶部的「系统架构」是一个与启动流程、UDS 同级的完整工作区，其中运行一套独立、可回放的教学状态机。它不修改原来的单 ECU、单核 42 步主线，而是用三个 profile 解释主线之外的实例边界、并行关系与故障门控；切换工作区不会清空当前 profile 和回放位置。

每个 profile 都支持正常启动和一个教学故障。可以单步、播放、重置，也可以点击时间线回放；节点颜色表示等待、当前执行、本地就绪、已上线或故障。点击节点会显示它的所有权和职责。

## 三种架构必须先分清

| 架构 | 实例边界 | 协调方式 | 本实验重点 |
| --- | --- | --- | --- |
| CDD | 同一 ECU 内的特殊驱动 | EcuM/BswM 模式、SchM/OS 临界区、Det/Dem、RTE 接口 | CDD 可以接近硬件，但仍必须受控、可审计 |
| 多 ECU | 多个独立 MCU、EcuM、OS 与故障域 | ComM、CanSM、Nm、网关路由、超时与功能可用性 | 本地请求不等于远端 ECU 已上线 |
| 多核 | 同一 ECU、同一多核 MCU | `StartCore`、各核 `StartOS`、OS-Application、IOC、Spinlock、启动屏障 | 共享资源初始化、核归属和同步点 |

不要把“多 ECU”和“多核”画成同一种复制关系。多 ECU 通过车载网络交互，可以独立掉电和重启；多核通常共享一个 ECU 的硬件与软件镜像，但每个核有自己的 OS 运行数据、栈、任务和中断归属。

## CDD 深入实验

示例把一个非标准角度传感 ASIC 分成以下路径：

`Angle ASIC → Spi Driver → Cdd_AngleSensor → RTE Port → Sensor SWC`

同时增加三条约束路径：

- EcuM/BswM 决定 CDD 的初始化、启动和降级模式。
- SchM 或 OS 机制保护任务、ISR、DMA 共享的关键资源。
- Det 与 Dem 分别承接开发错误和需要诊断化的运行事件。

AUTOSAR 的 CDD 设计指南明确提到 CDD 应保护关键资源，其模式可以由 EcuM/BswM 管理，并可使用 Det/Dem 报错；CDD 能直接面对特殊硬件，并不代表可以任意绕过 AUTOSAR 接口。[CDD 设计与集成指南][cdd]、[VFB][vfb]

故障场景在器件自检处注入 CRC 失败。观察 CDD 和 ASIC 进入故障态后，RTE 与 Sensor SWC 为什么必须保持未放行。

## 多 ECU 协同实验

示例包含 Gateway、Powertrain、Chassis 和 Body 四个独立 ECU，以及 PT-CAN、Body-CAN 两个网络簇。每个 ECU 都独立执行复位、EcuM、OS 和 BSW 启动；网关只能根据通信状态、Nm、报文与项目握手判断远端可用性，不能读取或伪造远端 EcuM 内部状态。

推荐观察顺序：

1. 多个 ECU 接收到相同唤醒条件，不代表它们同时启动完成。
2. `ComM_RequestComMode` 是本 ECU 的通信需求，远端 ECU 是否上线仍要等待网络证据。
3. 网关应在网段实际就绪、路由门控满足后才放开跨网段 PDU。
4. Body ECU 无 NM 响应时，其他域可以继续运行，但车辆级功能应明确进入降级状态。

后续如果要把现有 UDS 实验扩展成真正的多 ECU 诊断，下一层数据模型应为每个 ECU 保存独立的会话、安全、DTC 和刷写上下文，并增加目标 ECU、物理/功能寻址与网关路由；当前版本先专注启动和可用性边界。

## 多核启动实验

示例使用 Core 0 主核、Core 1 安全核和 Core 2 通信核。教学顺序是：

`Core 0 reset → shared clock/RAM → StartCore(1/2) → each core StartOS → OS-Application init → SchM/IOC → startup barrier → RTE/BSW events`

R24-11 EcuM 规范说明 `StartCore` 不应在 `StartOS` 之后调用；被 `StartCore` 成功启动的核需要调用 `StartOS`。[EcuM][ecum] AUTOSAR OS 的多核章节说明多核 OS 共享配置和大量代码，但每个核使用不同的运行数据结构；IOC 用于同核或跨核 OS-Application 通信，Spinlock 用于多核共享资源保护。[OS][os]

本实验还展示了 BSW 分区跨核交互时的 SchM/IOC 代理概念。真实分配由工具配置、BSW 分布、OS-Application、内存保护和安全分析共同决定，不应根据示意图直接编写量产配置。[BSW Distribution Guide][bsw-distribution]

故障场景让 Core 2 启动超时。Core 0 和 Core 1 可以到达局部就绪，但启动屏障会阻止依赖通信核的任务被错误放行。

## 学习边界

- 所有节点、耗时、核分配、网络拓扑和故障策略都是确定性教学数据。
- 没有执行真实 OS、核间中断、缓存一致性、MPU、CAN 仲裁或硬件寄存器。
- `StartupBarrier_WaitAll`、`VehicleModeManager_Update` 等名字是项目级教学伪 API，不是 AUTOSAR 标准接口。
- 量产多核设计还必须处理内存归属、缓存、启动超时、安全机制、锁顺序、WCET 和关机路径。

[cdd]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_CDDDesignAndIntegrationGuideline.pdf
[vfb]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_VFB.pdf
[ecum]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_ECUStateManager.pdf
[os]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_OS.pdf
[bsw-distribution]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_BSWDistributionGuide.pdf
