<!-- 分类 uds「诊断与刷写」· 原创教学源文本，语义参考 AUTOSAR R24-11 规范，不是规范原文 · 遵守「教学级行为仿真、非量产」边界 -->

# DCM 会话与安全状态机

<!-- doc: uds-dcm-session -->
<!-- tags: DCM, 会话, SecurityAccess, S3 -->
<!-- summary: 讲清默认/编程/扩展会话、S3 计时、0x27 Seed/Key 顺序与失败延迟，以及两道门的组合。 -->
<!-- refs: src-dcm -->

UDS 的会话与安全访问是所有受保护服务的前置门。这篇文档从默认会话讲到 0x27 的 Seed/Key 顺序与失败延迟，再看两道门如何组合成一次放行。

## 诊断会话的三种基本状态

<!-- keywords: 会话, 默认会话, 编程会话, 扩展会话, DCM -->

UDS 诊断以会话 Session 为上下文：默认会话 0x01 是复位后进入的受限状态，编程会话 0x02 用于刷写，扩展会话 0x03 提供更多服务权限。DCM 收到 10 02 或 10 03 后返回正响应并切换当前会话，之后各服务的可用性、可访问的 DID 与例程都会随会话变化。会话不是权限的全部，但它是所有服务前置条件的第一层。

## S3 计时器与会话保持

<!-- keywords: S3, TesterPresent, 默认会话, 安全等级, P2 -->

非默认会话由 S3 计时器（典型 5 秒）维持，只有持续收到 TesterPresent（3E 00）或其它诊断请求才刷新计时。S3 超时后 DCM 回到默认会话，同时安全等级通常被重置为锁定。S3 与 P2/P2* 不是同一类参数：S3 管会话保持，后者管单次请求的响应时限。理解这一点，才能解释为什么一段时间不操作就掉回默认会话。

## SecurityAccess 0x27 的 Seed/Key 顺序

<!-- keywords: 安全访问, 0x27, Seed, Key, 安全等级 -->

安全访问由一对子功能完成：0x27 请求种子，ECU 返回一个 Seed；诊断仪按约定算法算出 Key，用 0x27 的另一子功能连同 Key 发回，ECU 校验通过后把安全等级置为解锁。顺序被严格约束：必须先取 Seed 再发 Key，且 Seed 通常一次性有效。安全访问必须在扩展或编程会话中进行，服务本身往往还要求会话前提。

## 安全访问失败与延迟

<!-- keywords: NRC 0x35, NRC 0x37, 安全延迟, Seed, 密码学 -->

发错 Key 会得到负响应 NRC 0x35（invalidKey），连续多次失败后 ECU 进入安全延迟，再请求种子会被 NRC 0x37（requiredTimeDelayNotExpired）拒绝，直到延迟结束。延迟状态与会话内安全等级一起构成一个显式状态机。教学实验里的 Seed/Key 算法被公开且简单，只用于观察状态迁移，没有密码学安全性，绝不能当量产密钥设计。

## 会话与安全是两道门

<!-- keywords: 会话, 安全, 清除 DTC, DID, NRC -->

一个受保护服务往往同时受会话与安全两道门约束。例如清除 DTC 需要扩展或编程会话且已解锁；写入 DID 也类似。若会话不对，DCM 先回 NRC 0x7F；若会话对但未解锁，则回安全相关的 NRC。把两道门分开看，才能定位请求被拒到底卡在哪一层，而不是笼统归因于权限不足。

## 功能寻址与抑制正响应

<!-- keywords: 功能寻址, 物理寻址, 抑制正响应, DCM, 3E 80 -->

除了物理寻址，诊断还支持功能寻址：广播到一组 ECU，只有满足条件的 ECU 才响应。为避免总线上响应风暴，请求可设置抑制正响应位（例如 3E 80），让 ECU 执行但不在总线上回正响应。这些机制属于 DCM 的寻址与响应控制层，与会话、安全是正交的约束，理解它们能解释为什么某些请求看不到回应但已经生效。

# 诊断时序 P2/P2* 与 NRC 0x78

<!-- doc: uds-dcm-timing -->
<!-- tags: P2, P2*, NRC, 响应 -->
<!-- summary: 区分 P2 与 P2*、说明 NRC 0x78 的正确用法、负响应结构与常见 NRC 速记。 -->
<!-- refs: src-dcm -->

诊断仪等多久、ECU 用哪个 NRC 回应，决定了同一份服务描述在实车上的表现。这篇文档区分 P2 与 P2*，说明 NRC 0x78 的正确用法与负响应的结构。

## P2 与 P2* 的含义

<!-- keywords: P2, P2*, NRC 0x78, 超时, DCM -->

P2 是 ECU 对一次请求给出首个响应的最大时间，超时诊断仪会认为失败；P2* 是在发送 NRC 0x78（responsePending）之后，允许延长等待的时限。DCM 用它们调度服务处理与超时。教学实验中的这两个时间参数是示例，不应被当作真实 ECU 的实测值。

## NRC 0x78 的正确用法

<!-- keywords: NRC 0x78, P2*, 最终响应, 擦除, 分区 -->

当服务处理时间可能超过 P2 时，ECU 先回 NRC 0x78 表示请求仍在处理，随后在 P2* 期限内给出最终响应。0x78 不是失败，而是请继续等待的中间响应。实验里擦除这类耗时动作用 0x78 呈现，等待期间不会提前把目标分区标记为完成，这体现了协议顺序与真实状态的分离。

## 负响应的结构

<!-- keywords: 负响应, 7F, NRC, 无响应, SID -->

负响应固定为三字节起：0x7F、原请求 SID、NRC 码。例如 7F 14 7E 表示对 ClearDiagnosticInformation 的当前会话不支持拒绝。读懂这三个字节，就能快速区分是哪条服务、被什么原因拒绝。把无响应与负响应区分开很重要：7F 开头是 ECU 确实发出了回应，而无响应通常属于传输或链路层面问题。

## 常见 NRC 码速记

<!-- keywords: NRC, 0x11, 0x13, 0x24, 0x78 -->

常用 NRC 包括 0x11 服务不支持、0x12 子功能不支持、0x13 长度或格式错误、0x22 条件不满足、0x24 请求顺序错误、0x31 参数超出范围、0x33 安全访问被拒、0x35 无效 Key、0x37 延迟未到、0x72 编程失败、0x73 块序号错误、0x78 响应挂起。记住这些码的语义，比背具体数值更能定位问题所在层次。

## 无响应不等于某个 NRC

<!-- keywords: 无响应, NRC, Bus-Off, CanTp, 链路 -->

总线断开、Bus-Off、寻址不匹配或 CanTp 超时都会导致诊断仪收不到任何响应，这种无响应不是 ECU 返回了某个 NRC，而是传输或通信层面失败。把它解释成某个负响应码是常见的错误推断。正确做法是先确认链路与实际通信模式，再看协议层是否真的回了 7F 开头的负响应。

# DEM 事件内存与 DTC 状态字节

<!-- doc: uds-dem-dtc -->
<!-- tags: Dem, DTC, 状态字节, 事件内存 -->
<!-- summary: 说明 Dem_SetEventStatus、debounce 迁移、DTC 状态位含义、事件内存优先级与清除持久化边界。 -->
<!-- refs: src-dem -->

Dem 把 ECU 内部发生的事件变成可以被读出的 DTC。这篇文档讲事件上报与 debounce、状态字节的八位含义、事件内存与清除的持久化边界。

## Dem 的职责

<!-- keywords: Dem, Dem_SetEventStatus, debounce, DTC, 事件内存 -->

Dem（Diagnostic Event Manager）负责处理 ECU 内部的诊断事件：应用或 BSW 通过 Dem_SetEventStatus 上报事件通过、失败或预失败，Dem 依据配置的 debounce 策略判定事件是否稳定成立，再更新对应的 DTC 状态并管理事件内存。Dem 不直接与诊断仪通信，它把故障数据准备好，由 DCM 通过 0x19 等服务读出。

## DTC 状态字节的 8 位

<!-- keywords: testFailed, pendingDtc, confirmedDtc, 状态字节, warningIndicatorRequested -->

读取 DTC 时每个 DTC 附带一个状态字节，常见位含义包括：testFailed 表示当前测试失败、testFailedThisOperationCycle 表示本操作循环内曾失败、pendingDtc 表示待定、confirmedDtc 表示已确认、testNotCompletedSinceLastClear 表示清除后尚未完成测试、warningIndicatorRequested 表示请求点亮报警，另有保留位。理解每一位，才能解释为什么某 DTC 已确认但当前测试通过。

## debounce 与 pending/confirmed 的迁移

<!-- keywords: debounce, pending, confirmedDtc, healing, DTC -->

事件从一次失败到 confirmedDtc 通常要经历 debounce：连续失败达到阈值才判为 confirmed，中间状态可表现为 pending。恢复时也可能需要连续通过或特定的 healing 计数才清除。所以测到一次失败不等于已确认 DTC，诊断仪看到的 pending 与 confirmed 是两个不同成熟度的状态，工程上要区分报告与确认。

## 事件内存与优先级

<!-- keywords: 事件内存, 优先级, RAM-only, NvM, 掉电 -->

Dem 用事件内存保存 DTC 及其状态，内存可以配置为主/次存储或按优先级替换：当内存满而新故障优先级更高时，可挤出低优先级记录。事件内存还分 RAM-only 与持久化两类：RAM-only 的 Dem 掉电即丢失，使用持久块时则依赖 NvM 保存，使用前要检查其有效性与完整性。选哪种取决于项目对掉电后诊断连续性的要求。

## 0x19 读取 DTC 的子功能

<!-- keywords: 0x19, ReadDTCInformation, 状态掩码, DTC, 子功能 -->

ReadDTCInformation（0x19）有多个子功能：0x02 按状态掩码报告 DTC、0x01 报告数量、0x0A 报告支持的 DTC 等。诊断仪给出状态掩码，ECU 只返回满足条件的 DTC 记录，每条记录是三字节 DTC 加一字节状态。子功能与服务权限、会话条件相关，读 DTC 通常不需要解锁，但报告范围受掩码控制。

## DTC 清除的持久化边界

<!-- keywords: 0x14, Dem, NvM, 持久化, 掉电 -->

清除 DTC（0x14）在协议上会立即更新 Dem 当前的 RAM 状态，但它的长期效果取决于持久化：如果 Dem 使用持久化事件内存，清除意图要经 NvM 异步队列提交后才在掉电后保持。因此正响应已返回不等于掉电后 DTC 一定消失，这正是共享存储实验要展示的请求、提交与持久化之间的边界。

# 刷写流程 34/36/37

<!-- doc: uds-flashing -->
<!-- tags: 刷写, RequestDownload, TransferData, 例程 -->
<!-- summary: 梳理教学刷写顺序、RequestDownload 参数、块序号约束与擦除校验激活例程的边界。 -->
<!-- refs: src-dcm -->

刷写是 UDS 里顺序约束最强的一段流程。这篇文档按 34/36/37 梳理教学刷写路径，并指出它与真实安全刷写之间还差哪些工程条件。

## 刷写的基本顺序

<!-- keywords: 10 02, 27, 34, 36, 37 -->

一条典型教学刷写路径是：10 02 进入编程会话、27 完成安全访问、擦除非活动分区、34 RequestDownload 声明地址与长度、36 TransferData 分块传输、37 RequestTransferExit 结束、校验镜像、激活分区。每一步都为下一步建立前提，例如 0x36 之前必须存在有效的 RequestDownload，0x37 之前所有声明字节必须传完。

## RequestDownload 的参数

<!-- keywords: RequestDownload, 0x34, dataFormatIdentifier, 0x36, 地址 -->

RequestDownload（0x34）携带 dataFormatIdentifier、地址与长度等参数，ECU 据此判断能否接受这次下载，并可能返回最大块长度等限制。它只是启动下载过程，并不传输数据本身；后续 0x36 必须遵循此前声明的地址范围与总长度。把 0x34 当成开始写 Flash 是误读，真正的数据搬运发生在 0x36 阶段。

## TransferData 的块序号

<!-- keywords: TransferData, 0x36, 块序号, NRC 0x73, 0x24 -->

TransferData（0x36）携带块序号与数据，块序号必须从 1 开始连续递增；跳块或序号错误会得到 NRC 0x73。未声明下载就发送数据、镜像未收完整就结束、未校验就激活，都会因顺序错误得到相应 NRC，例如 0x24。块序号机制保证数据被有序、完整地重组，是刷写可靠性的基础。

## 擦除、校验与激活的例程

<!-- keywords: 0x31, 例程, 擦除, 校验, 激活 -->

实际刷写常配合例程控制（0x31）完成擦除、校验和激活：擦除非活动分区、对镜像做 CRC 校验、再激活新分区。这些例程 ID 在各项目里常是私有约定，教学实验用虚构的 FF00/FF01/FF02 表示，不能声称它们是标准例程。校验失败（如 CRC 错）应回相应 NRC，且活动分区与版本保持不变。

## 刷写之外的工程条件

<!-- keywords: 供电, 签名, Bootloader, P2, NRC 0x78 -->

真实安全刷写远不止协议顺序：还需要稳定的供电条件、Flash 驱动、掉电恢复、签名与证书链、安全启动、防回滚、兼容性检查、Bootloader 跳转、真实的 P2/P2* 调度、传输超时与失败回滚。教学实验只用确定的 NRC 0x78 擦除等待来呈现顺序与门控，不涉及这些量产要素，不能据此认为已经具备可烧录能力。

# ISO-TP 分帧与流控

<!-- doc: uds-isotp -->
<!-- tags: ISO-TP, CanTp, 流控, 分帧 -->
<!-- summary: 解释 SF/FF/FC/CF 四种帧、Block Size 与 STmin、流控与超时故障，以及 CAN FD 的边界。 -->
<!-- refs: src-cantp -->

UDS 服务跑在 ISO-TP 之上，长报文必须先分帧。这篇文档讲清 SF/FF/CF/FC 四种帧、流控参数的作用，以及 CAN FD 改变了什么、没改变什么。

## ISO-TP 的分帧角色

<!-- keywords: ISO-TP, CanTp, UDS, First Frame, Consecutive Frame -->

ISO-TP（ISO 15765-2）是 CAN 上的传输层，负责把超过单帧容量的诊断消息分段为若干 CAN 帧并在接收端重组。UDS 负责服务语义，CanTp 负责分段、流控与重组的机械工作，两者是不同层次。一条长响应的展开通常是 First Frame、Flow Control、多个 Consecutive Frame，理解这条路径才能读懂诊断仪与 ECU 的交互。

## SF/FF/CF/FC 四种帧

<!-- keywords: 单帧, 首帧, 连续帧, 流控帧, 序号 -->

ISO-TP 有四种帧类型：单帧 SF 承载能放进一帧的短消息；首帧 FF 声明总长度并携带开头数据；连续帧 CF 按序号续传剩余数据；流控帧 FC 由接收端告诉发送端可以继续、等待还是溢出。每次分段传输都是一次收发双方按帧类型与序号配合的协议过程，而不是简单的数据切割。

## Block Size 与 STmin

<!-- keywords: Block Size, STmin, 流控帧, 吞吐, 缓冲 -->

流控帧携带 Block Size 与 STmin：Block Size 规定发送端在等下一个流控前最多连续发多少帧，STmin 规定两帧之间的最小间隔。调小 Block Size 或增大 STmin 会降低吞吐但提高可靠性，反之更容易因缓冲不足丢帧。这些参数属于传输层的节奏控制，与应用层服务语义无关。

## 流控与超时故障

<!-- keywords: 流控, 超时, 序号, 传输台, 负响应 -->

若发送端等不到流控帧、或接收端缓冲溢出、或连续帧序号错误，传输就会失败。教学传输台可以注入丢 FC、丢 CF 和错误序号，用来区分协议层失败与应用层负响应。这类失败不会变成某个 UDS 负响应码，而是传输超时或重组失败，是理解诊断无响应原因的重要一环。

## CAN FD 不改变 ISO-TP 语义

<!-- keywords: CAN FD, ISO-TP, 流控, UDS, 数据长度 -->

CAN FD 单帧可承载更多数据，因此相同负载所需的分段帧更少，但 CAN FD 不会消除 ISO-TP 的流控、顺序检查与超时概念，也不会改变 UDS 的服务语义。以为 CAN FD 能提升 UDS 语义是常见误解：它只放宽了单帧载荷与数据长度，协议层的分段与确认规则依旧存在。
