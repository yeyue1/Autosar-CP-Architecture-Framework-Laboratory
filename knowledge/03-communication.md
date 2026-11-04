<!-- 分类 communication「通信与网络管理」· 原创教学源文本，语义参考 AUTOSAR R24-11 规范，不是规范原文 · 遵守「教学级行为仿真、非量产」边界 -->

# COM/PduR/CanIf/CanTp 数据路径

<!-- doc: comm-pdur-path -->
<!-- tags: COM, PduR, CanIf, CanTp -->
<!-- summary: 沿一条应用输出追到底层与总线，讲清 PduR 路由、CanIf 边界、发送确认与诊断共用路径。 -->
<!-- refs: src-com, src-pdur -->

一次应用输出要穿过 RTE、COM、PduR、CanIf 才能上总线。这篇文档沿这条路径逐层说明职责边界，并解释发送确认为什么不等于对端已收到。

## 从应用到总线的路径

<!-- keywords: RTE, COM, PduR, CanIf, I-PDU -->

一条应用输出的典型下行路径是：SWC 经 RTE 写入信号，COM 把信号打包进 I-PDU，PduR 按路由把 PDU 交给 CanIf，CanIf 发到 CAN 驱动，最终上总线。接收方向相反：驱动收帧、CanIf 过滤、PduR 分发、COM 解包、RTE 更新，再触发 runnable。理解这条链路，才能定位一次数据未到达到底断在哪一层。

## PduR 的路由角色

<!-- keywords: PduR, COM, CanIf, CanTp, Dcm -->

PduR（PDU Router）位于通信栈中部，负责在不同上层模块与下层总线接口之间转发 PDU：把 COM 的发送 PDU 路由到 CanIf，把 CanIf 收到的 PDU 路由到 COM 或 CanTp，把 CanTp 的诊断 PDU 路由到 Dcm。路由关系完全由配置决定，PduR 本身不解释数据内容。它是通信数据路径与诊断数据路径共用的交通枢纽。

## COM 的信号打包与发送模式

<!-- keywords: COM, 信号, I-PDU, 周期发送, 事件发送 -->

COM 把多个信号按配置打包进 I-PDU，并按发送模式决定何时发送：周期发送、事件发送或混合。收到信号后可能触发 PDU 更新，再由下层周期或立即发出。信号的初值、更新位、超时替换值也由 COM 管理，因此应用的信号与总线上的报文并不是一一对应，理解打包与发送模式才能解释报文时序。

## CanIf 的职责边界

<!-- keywords: CanIf, CAN 驱动, 发送缓冲, 收发过滤, CanTp -->

CanIf（CAN Interface）在 CAN 驱动与上层之间做抽象：管理发送缓冲、PDU 通道、硬件对象映射与收发过滤，并向上报告收发结果。它不负责分段（那是 CanTp）也不负责信号打包（那是 COM）。CanIf 还能表达发送确认与错误通知，是观察报文是否真的发出这一层的合适位置。

## 发送确认不等于对端已收到

<!-- keywords: 发送确认, 远端, E2E, 端到端, 监督 -->

底层给出的发送确认通常表示帧已被控制器成功发出，或至少进入发送过程，并不等于远端 ECU 已经收到或应用已经处理。真正的端到端确认要靠应用层握手、周期监督或 E2E 保护来判断。把发送确认当成端到端送达，是通信诊断里很常见的过度乐观。分辨发送这一层与送达这一层，能避免把链路正常误判为业务已经完成。

## 诊断与应用的共用路径

<!-- keywords: 诊断, RTE, PduR, CanTp, Bus-Off -->

诊断请求与应用信号共享同一套底层：诊断帧经 CanIf、CanTp、PduR 到达 Dcm，应用信号经 CanIf、PduR、COM 到达 RTE。二者在 PduR 处分流，但都依赖 CAN 驱动与总线可用。因此总线 Bus-Off 时，应用报文与诊断请求会同时受影响，这也解释了为什么诊断无响应有时与协议无关。

# 网络管理 NM 状态机

<!-- doc: comm-nm -->
<!-- tags: NM, ComM, 休眠, 唤醒 -->
<!-- summary: 从 Nm_NetworkRequest 到 BusSleep，讲清 RepeatMessage、NormalOperation 与超时刷新。 -->
<!-- refs: src-nm -->

网络管理让同一网络上的节点一起醒、一起睡。这篇文档按 RepeatMessage、NormalOperation、PrepareBusSleep、BusSleep 走一遍完整的 NM 状态链。

## NM 的目标

<!-- keywords: 网络管理, NM, 唤醒, 休眠, NM 报文 -->

网络管理 NM 的目标是协调同一网络上的节点，使它们在需要通信时一起保持唤醒，在都不需要时一致地进入休眠，避免某些节点独自休眠导致网络无法唤醒。NM 通过周期发送 NM 报文互相报到，每个节点根据本地请求与他人报文决定状态。它解决的是网络级协同，而不是单个 ECU 的业务。

## RepeatMessage 状态

<!-- keywords: Nm_NetworkRequest, RepeatMessage, NM 报文, 唤醒, 超时 -->

节点通过 Nm_NetworkRequest 发起网络请求后进入 RepeatMessage 状态，此阶段以较快周期发送 NM 报文，声明自己希望网络保持唤醒。收到其它节点的 NM 报文会刷新接收超时，使网络继续保持活跃。RepeatMessage 是我要用网络的显式表达，也是网络被唤醒后各节点达成一致的第一步。

## NormalOperation 与 ReadySleep

<!-- keywords: NormalOperation, ReadySleep, PrepareBusSleep, BusSleep, 超时 -->

网络正常通信时，节点处于 NormalOperation 状态并按需维持 NM 报文；当节点不再需要网络时，它停止请求并进入 ReadySleep，等待网络整体安静，只要仍收到他人 NM 报文就维持。当所有节点都不再请求且超时到期，网络才进入 PrepareBusSleep，最终 BusSleep。因此本地释放请求并不等于立即休眠，因为别的节点的报文仍会让网络保持唤醒。

## PrepareBusSleep 与 BusSleep

<!-- keywords: PrepareBusSleep, BusSleep, 收发器, 唤醒, 休眠 -->

PrepareBusSleep 是休眠前的缓冲状态，此时节点通常已停止发送应用报文，等待总线安静并准备关闭收发器；之后进入 BusSleep，收发器进入低功耗并依赖唤醒事件。收到唤醒条件（如总线活动或本地唤醒源）会触发网络重新唤醒，流程回到 RepeatMessage。这条状态链是观察整车休眠与唤醒节奏的核心。

## NM 报文周期与超时

<!-- keywords: NM 报文, 超时, 周期, 休眠, 释放 -->

NM 报文的周期与超时参数决定了网络收敛速度：周期过快会增加总线负载，过慢会让休眠判断迟迟不成立。教学实验里的时间参数放在配置中，其它节点的 NM 报文会刷新接收超时，所以一个节点释放本地请求后，仍要等所有节点都安静、超时都到期，网络才会整体转入休眠。

# ComM 与 CanSM 模式许可

<!-- doc: comm-comm-cansm -->
<!-- tags: ComM, CanSM, 通信模式, 许可 -->
<!-- summary: 分清通信许可、请求模式与实际模式，说明 CanSM 异步推进和 SILENT_COM 的含义。 -->
<!-- refs: src-comm, src-cansm -->

通信许可、请求模式与实际模式是三件不同的事。这篇文档说明 ComM 与 CanSM 如何分工，以及为什么请求了 FULL 与真正处于 FULL 可以暂时不同。

## ComM 的许可与请求

<!-- keywords: ComM, CommunicationAllowed, ComM_RequestComMode, FULL_COMMUNICATION, BswM -->

ComM（Communication Manager）管理每个通道的通信模式。初始化后通道的 CommunicationAllowed 默认关闭；放开许可（通常由 BswM 动作调用 ComM_CommunicationAllowed）是前提，应用再通过 ComM_RequestComMode 申请 FULL_COMMUNICATION。放开许可、申请模式、总线真正进入该模式是三件不同的事，不能只看模块是否变绿。

## 请求模式与实际模式

<!-- keywords: ComM_RequestComMode, CanSM, 实际模式, 请求模式, ComM_BusSM_ModeIndication -->

ComM_RequestComMode 表达本 ECU 的通信需求，它可能立即接受请求却暂时达不到实际模式：还要经 CanSM 推进控制器与收发器状态，最终由 ComM_BusSM_ModeIndication 之类接口反馈实际模式。所以请求了 FULL 与实际处于 FULL 可以暂时不同，尤其在上电早期或故障恢复时。

## CanSM 的异步推进

<!-- keywords: CanSM, CanSM_RequestComMode, 异步, 收发器, E_OK -->

CanSM（CAN State Manager）负责把 ComM 的请求翻译成 CAN 控制器与收发器的具体模式推进。CanSM_RequestComMode 是异步接口，返回 E_OK 只表示请求被接受，真实状态要经过控制器模式确认、收发器使能等步骤，再以指示回调反馈。CAN 控制器已初始化不等于所有应用 PDU 已获准发送。

## SILENT_COM 与 Bus-Off

<!-- keywords: SILENT_COM, Bus-Off, RUN, 通信, 发送 -->

当总线出现 Bus-Off，实际通信模式可能停滞在 SILENT_COM：控制器只能听不能发。此时应用仍可处于 RUN，但报文发不出去，系统不会伪造成功发送。区分应用可运行与通信实际可用很重要，尤其在做故障诊断时，前者不代表后者，后者也不代表每条网络都 FULL。

## 通道与 ECU 不是一对一

<!-- keywords: ComM, 通道, RUN, FULL, 降级 -->

一个 ECU 可能管理多条 ComM 通道，每条通道有独立的许可与模式；ECU 处于 RUN 并不意味着每条网络都是 FULL。应用的可运行状态与具体网络的需求应当分开看，不能用一条通道的状态代表整个 ECU 的业务可用性。这是理解整车级可用性与降级策略的基础。

# E2E 端到端保护

<!-- doc: comm-e2e -->
<!-- tags: E2E, CRC, 计数器, 功能安全 -->
<!-- summary: 讲清 E2E 保护目标、CRC 与计数器分工、Profile 配置一致性与「机制不等于安全」。 -->
<!-- refs: src-e2e -->

E2E 保护的是端到端语义，而不是单段链路。这篇文档讲 CRC 与计数器的分工、Profile 一致性的影响，并重申「机制不等于安全」。

## E2E 保护的目标

<!-- keywords: E2E, 完整性, CRC, 计数器, data ID -->

端到端保护 E2E 在通信两端之间检测数据完整性风险：报文被篡改、丢失、重复、乱序或延迟。E2E 通常在发送端附加 CRC 与计数器以及 data ID 等，接收端据此校验并做出接受、丢弃或上报的处理。它保护的是端到端的语义，而不仅是单段链路，因此跨越网关时依然有效。

## CRC 与计数器的分工

<!-- keywords: CRC, 计数器, 丢帧, 重复, 乱序 -->

E2E 里 CRC 负责检测数据是否被破坏，计数器负责检测报文是否丢失、重复或乱序；两者互补。接收端把计数器与上次比较：递增 1 为正常，跳变为丢帧，不变为重复，回退为乱序。结合 CRC 校验，接收端才能较可靠地判断数据是否可以信任，而不是只看某一次校验是否通过。

## E2E 不是功能安全已经达成

<!-- keywords: E2E, 功能安全, ISO 26262, 安全目标, 安全机制 -->

E2E 是提升通信数据可信度的机制，它有助于功能安全，但本身不等于完成 ISO 26262 的安全目标。功能安全还需要危害分析、安全目标、安全机制组合（含看门狗、内存保护、安全状态等）、验证与确认。把 E2E 当作已经功能安全是常见误解，它只是可选安全机制中的一个环节。

## E2E Profile 与配置一致性

<!-- keywords: E2E, Profile, CRC, 配置, 接口 -->

E2E 有不同的 Profile，定义计数器宽度、CRC 多项式与数据布局等参数，发送与接收两端必须使用同一个 Profile 与配置才能互认。配置不一致会导致接收端持续判定校验失败，看起来像通信坏了，其实是两端保护参数不匹配。因此跨 ECU 的 E2E 参数要与接口描述保持一致。

## E2E 与 COM 的叠加关系

<!-- keywords: E2E, COM, RTE, PDU, ISO-TP -->

E2E 保护通常由 E2E 库与 COM/RTE 协作完成：发送前计算保护字段并放入信号或 PDU，接收后取出并校验。它不替代 COM 的打包，也不替代 ISO-TP 的分段，而是叠在应用数据之上的一层语义保护。理解这层叠加关系，才能解释为什么 PDU 结构里会多出 CRC 与计数器这些字段。

# CAN FD 与经典 CAN

<!-- doc: comm-canfd -->
<!-- tags: CAN FD, 经典 CAN, 帧数, 兼容 -->
<!-- summary: 说明 CAN FD 的载荷扩展、对 ISO-TP 的实际影响、报文格式差异与迁移兼容性。 -->
<!-- refs: src-cantp -->

CAN FD 把单帧载荷从 8 字节扩展到 64 字节。这篇文档说明它实际改变了什么、对 ISO-TP 的影响落在哪里，以及迁移时的兼容性约束。

## CAN FD 的载荷扩展

<!-- keywords: CAN FD, 经典 CAN, 64 字节, 负载, 帧数 -->

CAN FD 把单帧数据域从经典 CAN 的 8 字节扩展到最多 64 字节，并采用更高的数据段码率，因此同一份负载所需帧数更少。它改变的是单帧容量与速率，不改变上层协议语义。诊断负载更长时，CAN FD 能显著减少分段帧，但分段、流控、确认这些协议规则依旧存在。

## CAN FD 对 ISO-TP 的影响

<!-- keywords: CAN FD, ISO-TP, 流控, Block Size, 序号 -->

在 ISO-TP 层，CAN FD 只是把单帧能装的数据变多，因此首帧与连续帧数量减少，流控节奏有所变化，但 Block Size、STmin、序号与超时机制不变。以为 CAN FD 能省略流控或提升 UDS 语义是错误的：它放宽的是数据长度，协议层的分段与确认规则仍然完整保留。

## CAN FD 报文格式差异

<!-- keywords: CAN FD, DLC, 数据域, 位时序, 仲裁 -->

CAN FD 帧在控制段引入了新的位与更长的 DLC 编码，支持更大数据域；这也影响位时序与采样点配置。教学实验只模拟数据长度对 ISO-TP 分帧的影响，不模拟位级时序、仲裁或误码。理解这一点可以避免把减少帧数误解成总线一定更快或更可靠。

## CAN FD 迁移的兼容性

<!-- keywords: CAN FD, 经典 CAN, 网关, 兼容, 收发器 -->

经典 CAN 与 CAN FD 混跑需要网关做格式转换或网段隔离，不同节点对 FD 的支持能力不同。把 FD 引入既有网络时，要评估控制器、收发器与网关能力，并确认诊断测试仪也支持 FD。以为改一个开关就能让整网提速，往往忽略了这些兼容性约束。
