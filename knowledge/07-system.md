<!-- 分类 system「系统架构与 CDD」· 原创教学源文本，语义参考 AUTOSAR R24-11 规范，不是规范原文 · 遵守「教学级行为仿真、非量产」边界 -->

# CP 分层架构与 RTE

<!-- doc: system-layering -->
<!-- tags: SWC, RTE, BSW, MCAL -->
<!-- summary: 从应用层到 MCAL 梳理分层职责，说明 RTE 作为契约层、SWC 端口与可移植性的代价。 -->
<!-- refs: src-vfb -->

这篇文档从应用层到 MCAL 梳理 CP 的分层职责，说明 RTE 为什么是契约层，以及可移植性背后必须付出的代价。

## AUTOSAR CP 的分层

<!-- keywords: AUTOSAR, SWC, RTE, BSW, MCAL -->

AUTOSAR Classic Platform 自上而下大致分为应用层 SWC、RTE、BSW 与 MCAL。应用层通过 RTE 与外界交互，不直接触碰底层；RTE 是应用与 BSW 之间的契约层；BSW 提供服务，包括通信、诊断、存储、模式管理与 OS；MCAL 直接驱动 MCU 外设。分层让软件可移植、可复用，也让职责边界清晰。

## RTE 作为契约层

<!-- keywords: RTE, SWC, BSW, sender/receiver, 生成 -->

RTE 由工具根据 SWC 描述与配置自动生成，是连接应用与 BSW 的契约：它把 sender/receiver 数据、client/server 服务、模式切换与触发映射成具体函数与事件。应用只依赖 RTE 接口，不直接调用 BSW，因此换下层实现时应用可基本不变。把 RTE 当成可手写的普通模块，会忽视它由生成代码承载这一事实。

## BSW 的组成

<!-- keywords: BSW, OS, NvM, Dcm, Dem -->

BSW 包含系统服务，如 OS、EcuM、BswM、WdgM；存储服务，如 NvM、MemIf、Fee、Fls；通信服务，如 ComM、NM、Com、PduR、CanTp、CanIf；诊断服务，如 Dcm、Dem；以及 I/O 抽象。它们分层协作，通过配置生成代码。理解 BSW 各子栈的职责，才能判断某个功能该由谁负责，而不是把所有逻辑塞进一个模块。

## MCAL 的职责

<!-- keywords: MCAL, Mcu, Port, Fls, Can -->

MCAL（Microcontroller Abstraction Layer）把 MCU 外设封装成标准接口：Mcu 管时钟与复位、Port 管引脚复用、Dio 管数字 I/O、Spi/Adc/Pwm 管外设、Fls 管 Flash、Can 管 CAN 控制器。MCAL 之上是 ECU 抽象与 BSW。MCAL 直接面对寄存器，是移植到新硬件时最需要替换的一层。

## SWC 与接口描述

<!-- keywords: SWC, Port, sender/receiver, client/server, RTE -->

SWC（Software Component）是应用功能的封装单位，通过端口 Port 暴露 sender/receiver 或 client/server 接口，接口内容由软件组件描述定义。SWC 之间不直接调用，而是经 RTE 连接。把 SWC 的可连接性建立在接口描述上，使系统集成可以在不改代码的情况下重连组件，这是 AUTOSAR 复用的基础。

## 分层与可移植性

<!-- keywords: 分层, 可移植, RTE, MCAL, 配置 -->

分层的价值在于可移植与可替换：应用依赖 RTE，BSW 依赖 MCAL 的硬件抽象，因此更换 MCU 时主要替换 MCAL，更换应用时主要重连端口。但这种可移植不是免费的，它依赖配置与接口描述的一致、工具链的生成能力，以及各模块对规范约束的遵守。分层画得再漂亮，配置不对照样跑不通。

# CDD 与特殊硬件

<!-- doc: system-cdd -->
<!-- tags: CDD, ASIC, 关键资源, Det -->
<!-- summary: 说明 CDD 的定位、与标准驱动的取舍、关键资源保护、模式管理接口与错误上报分层。 -->
<!-- refs: src-cdd -->

标准 BSW 表达不了的需求会落到 CDD 上。这篇文档说明 CDD 的定位、与标准驱动的取舍、关键资源保护，以及错误上报的分层。

## CDD 的定位

<!-- keywords: CDD, ASIC, EcuM, BswM, Det -->

CDD（Complex Device Driver）用于标准 BSW 无法高效或无法表达的场合，例如特殊 ASIC、时序敏感的外设、非标准协议。CDD 可以直接访问硬件，但仍必须受 AUTOSAR 框架约束：它可以被 EcuM/BswM 的模式管理、用 SchM 或 OS 保护关键资源、通过 Det/Dem 上报错误，并通过 RTE 向上提供接口。

## CDD 与标准驱动的取舍

<!-- keywords: CDD, 标准驱动, MCAL, 时序, 验证 -->

标准驱动遵循统一的 MCAL 或 ECU 抽象接口，便于替换与复用；CDD 则为了特定器件或性能要求而定制，接口可能不完全标准化。选择 CDD 通常是因为标准栈无法满足时序或功能需求，但代价是更多的自制代码与验证负担。把本可用标准驱动实现的功能硬做成 CDD，会增加维护成本。

## 关键资源保护

<!-- keywords: CDD, 共享资源, SchM, OS 资源, Spinlock -->

CDD 常同时被任务、ISR 甚至 DMA 访问，共享资源必须保护。可以用 SchM 的临界区、OS 资源或 Spinlock 保证一致性。CDD 设计指南明确要求保护关键资源，避免并发访问破坏数据。把 CDD 能碰硬件误解成 CDD 可以无视并发，是实际调试中最常见的坑之一。

## 与模式管理的接口

<!-- keywords: CDD, EcuM, BswM, 模式管理, 降级 -->

CDD 的初始化、启动与降级可以由 EcuM/BswM 的模式管理驱动：例如初始化在其 InitBlock 中完成，启动在模式切换时放开，故障时进入降级。把 CDD 的状态纳入统一模式管理，能让它和整车生命周期协调，而不是各自为政。缺少这种协调，CDD 可能在错误的时刻被访问或放行。

## 错误上报的分层

<!-- keywords: CDD, Det, Dem, DTC, 错误 -->

CDD 的错误分两类：开发期错误，如参数非法、调用顺序错误，上报 Det；运行期需要诊断化的事件上报 Dem 形成 DTC。把两类混在一起会让诊断与调试都混乱。设计良好的 CDD 会区分程序缺陷与运行故障，并分别走 Det 与 Dem，使问题既能被开发工具发现，也能被诊断仪读出。

# SchM 调度与排他区

<!-- doc: system-schm -->
<!-- tags: SchM, MainFunction, 排他区, 代理 -->
<!-- summary: 说明 SchM 的角色、启动序列、排他区保护、跨分区代理以及与 OS 的关系。 -->
<!-- refs: src-ecum -->

BSW 的周期函数不会自己运行，SchM 负责把它们挂到调度上。这篇文档讲 SchM 的角色、启动序列、排他区与跨分区代理。

## SchM 的角色

<!-- keywords: SchM, BSW, MainFunction, 调度, 分区 -->

SchM（BSW Scheduler）为 BSW 模块提供调度服务：它把周期处理的 MainFunction 映射到底层任务或调度表中，并协调多分区、多核下的调用。应用通常不直接调用 SchM，而是通过配置把 BSW 的周期函数挂到调度上。理解 SchM，才能解释 BSW 的 MainFunction 什么时候被执行。

## SchM 的启动序列

<!-- keywords: SchM_Start, BswM_Init, SchM_Init, SchM_StartTiming, 启动 -->

启动时常见顺序是 SchM_Start、BswM_Init、SchM_Init、SchM_StartTiming。SchM_Start 对接调度启动阶段，BswM_Init 初始化模式管理，SchM_Init 完成 SchM 自身初始化，SchM_StartTiming 放开周期时间基准。不要仅凭函数名把 SchM_Init 放到 SchM_Start 前面，具体顺序以所选版本与生成代码为准。

## 临界区与排他区

<!-- keywords: SchM, 排他区, exclusive area, 共享, 实时性 -->

SchM 提供排他区 exclusive area 接口，用于保护跨模块共享的数据或硬件访问，例如 SchM_Enter 与对应 Exit 的成对调用。它相当于在 BSW 层的一把锁，保证同一时刻只有一个执行体进入。把排他区当成万能锁滥用，会拉长阻塞时间、影响实时性，应尽量缩小范围。

## 跨分区与代理

<!-- keywords: SchM, 分区, 代理, IOC, 跨核 -->

当 BSW 分布在多个分区或核上时，SchM 可以承担调用与数据代理：调用方经 SchM 转发到真正拥有者所在分区，数据也可能经 IOC 传递。这种代理让分区隔离与功能调用并存。理解代理概念，才能解释为什么一次 BSW 调用在跨核时不是简单的函数跳转，而涉及同步与数据搬运。

## SchM 与 OS 的关系

<!-- keywords: SchM, OS, 任务, 调度表, 时序 -->

SchM 建立在 OS 之上：它把 BSW 周期函数映射成 OS 任务或调度表条目，依赖 OS 完成实际调度。SchM 本身不实现抢占或时间片，它只负责把 BSW 的调用挂到合适的调度实体上。因此 OS 配置一变，SchM 映射的时序也会变，二者必须一起设计，而不是孤立调整。

# WdgM 监督与功能安全

<!-- doc: system-wdgm -->
<!-- tags: WdgM, 看门狗, 监督, 功能安全 -->
<!-- summary: 说明 WdgM 的功能级存活监督、三种监督模式、看门狗分层与和功能安全的关系。 -->
<!-- refs: src-wdg -->

WdgM 监督的是功能是否按节奏活着，而不是单个任务跑了多久。这篇文档说明三种监督模式、看门狗分层，以及它与功能安全的关系。

## WdgM 的职责

<!-- keywords: WdgM, Supervised Entity, alive, 喂狗, 复位 -->

WdgM（Watchdog Manager）负责功能级存活监督：它把受监督实体 Supervised Entity 的 alive 检查点聚合起来，判断相关功能是否按预期节奏执行，再据此喂狗或触发复位。它监督的是程序是否在正确节奏推进，而不是单个任务的执行时间。把 WdgM 和 OS 时间保护混为一谈，会误判监督层次。

## 监督模式

<!-- keywords: WdgM, Alive Supervision, Deadline Supervision, Logical Supervision, 检查点 -->

WdgM 支持不同的监督模式：Alive Supervision 检查实体是否按顺序报告检查点；Deadline Supervision 检查检查点之间的时间窗；Logical Supervision 检查程序控制流的合法顺序。三者从不同角度捕捉异常。配置时应按功能风险选择合适的组合，而不是一律开启全部监督导致误报。

## 看门狗的分层

<!-- keywords: 看门狗, WdgM, Wdg, Wdg_SetTriggerCondition, 复位 -->

看门狗通常分内部看门狗与外部看门狗，由 WdgM 决定喂狗节奏，再由 Wdg 驱动通过 Wdg_SetTriggerCondition 之类接口真正触发硬件。喂狗过早过频会降低监督价值，过晚则可能误复位。因此喂狗时机应与监督结果绑定，而不是固定周期无条件喂。

## 与功能安全的关系

<!-- keywords: WdgM, 功能安全, ISO 26262, 安全机制, 安全目标 -->

WdgM 是功能安全常用的安全机制之一，但单独存在不等于满足 ISO 26262：还需要危害分析、安全目标、其它安全机制组合、验证与确认，以及独立性与安全案例。把有看门狗当成已经功能安全是典型误解。AUTOSAR 提供机制与框架，安全目标的达成仍是系统工程问题。
