<!-- 分类 startup「启动与 EcuM」· 原创教学源文本，语义参考 AUTOSAR R24-11 规范，不是规范原文 · 遵守「教学级行为仿真、非量产」边界 -->

# EcuM Flexible 启动顺序

<!-- doc: startup-ecum-flexible -->
<!-- tags: EcuM, StartOS, BswM, 启动 -->
<!-- summary: 从复位到 StartOS 之前与之后，EcuM 如何组织初始化块、配置选择与 post-OS 骨架。 -->
<!-- refs: src-ecum, src-mode-guide -->

这篇文档沿一次冷启动走一遍 EcuM Flexible 的主线：从复位后的第一个 BSW 入口，到 InitZero 与 InitOne 的分段，再到 StartOS 那次不可逆的控制权交接。读完应当能说清 pre-OS 与 post-OS 两段各自能做什么、不能做什么。

## EcuM_Init 是上电后的第一个 BSW 入口

<!-- keywords: EcuM_Init, StartOS, InitBlock, Cat2 -->

复位向量完成最小 C 环境（栈指针、时钟与 .data/.bss 初始化）之后，控制权交给 EcuM_Init()。此时操作系统尚未启动，因此 EcuM_Init 只能在中断受控、无 Cat2 中断依赖的上下文中准备基础条件：多核共享初始化、驱动初始化块 InitBlock、时钟与看门狗预配置。它不负责把系统推进到业务运行，只负责把系统带到可以调用 StartOS 的门槛。

## InitZero 不使用 Post-Build 配置

<!-- keywords: InitZero, InitOne, Post-Build, 一致性校验 -->

EcuM 启动分为 InitZero 与 InitOne 两段。InitZero 运行在 Post-Build 配置仍不可用的早期阶段，只能用预编译时已知的信息，例如把 RAM 变量、栈与最小驱动准备到可用。当配置被加载并完成一致性校验后，才进入 InitOne，此时才能使用更完整的配置数据做初始化。混淆两段会误以为所有初始化都能读到配置。

## Post-Build 配置选择与校验

<!-- keywords: Post-Build, Flexible, 一致性, BswM -->

Flexible EcuM 支持 Post-Build 与 Pre-Compile 等配置方式。使用 Post-Build 时，EcuM 在启动早期从固定位置选择一份配置指针，并通过配置 ID 与校验值做一致性检查，确认选中的初始化数据与当前软件匹配。若校验失败，系统应进入定义好的错误处理，而不是用一份不确定的配置继续启动。这一步决定了后续 InitOne 与 BswM 规则求值所依据的是哪套配置。

## StartOS 是控制权边界

<!-- keywords: StartOS, 控制权, 启动钩子, 自动启动任务, StartupTwo -->

StartOS 是启动流程中真正的控制权分界。调用 StartOS 之前，代码仍以顺序方式运行；调用之后，调度器接管，按配置激活自动启动任务与启动钩子，原来的顺序代码不再直接回退。因此 EcuM 的启动被拆成 pre-OS 与 post-OS 两段，中间隔着一次不可逆的控制权交接，这正是理解 StartupTwo 为何不在同一调用栈里的关键。

## post-OS 骨架顺序

<!-- keywords: SchM_Start, BswM_Init, SchM_Init, SchM_StartTiming -->

post-OS 阶段的调用骨架通常写作 SchM_Start、BswM_Init、SchM_Init、SchM_StartTiming 的顺序。不要仅凭函数名称把 SchM_Init 放到 SchM_Start 之前：SchM_Start 用于对接调度启动阶段，BswM_Init 会按配置初始化模式管理，随后才启动时间基准。具体顺序仍以所选版本与配置生成的代码为准，教学顺序用于理解依赖关系而非量产模板。

## InitBlock 与驱动初始化位置

<!-- keywords: InitBlock, Mcu, Port, 上电时序 -->

EcuM 用初始化块 InitBlock 把 Mcu、Port、Dio、Adc、Spi 等基础驱动组织成分组调用，顺序受硬件上电时序与模块依赖约束。并不是所有驱动都能放进同一个 InitBlock：有的必须在时钟稳定后、有的要等通信控制器就绪、有的需要 OS 之后。把示例分组当成唯一答案很危险，真实项目应按 MCU 手册与各模块 SWS 的初始化前置条件推演。

# Fixed 与 Flexible 状态机差异

<!-- doc: startup-fixed-vs-flexible -->
<!-- tags: Fixed, Flexible, STARTUP, BswM -->
<!-- summary: 对照旧 Fixed 状态机与现代 Flexible 启动骨架，说清哪些术语是历史包袱、哪些不能照搬。 -->
<!-- refs: src-ecum, src-fixed -->

旧 EcuM Fixed 的状态表常被当成现代 Flexible 的实现，这篇文档把两者的组织方式并排说明。目的在于分清哪些术语只是历史包袱，哪些结论不能照搬到今天的 CP 平台。

## Fixed 与 Flexible 的组织者不同

<!-- keywords: Fixed, Flexible, STARTUP, BswM, DriverInit -->

旧 EcuM Fixed（历史上以 R4.3.1 为参考）用一个固定状态机把启动拆成 STARTUP I、STARTUP II、RUN 等状态，并配有 DriverInitOne/Two/Three 等专用 callout，状态迁移路径是写死的。现代 EcuM Flexible 只保留启动骨架，把后续流程交给 BswM 按配置规则推进。两者共享上电早期概念，但不能把 Fixed 的状态表直接当成 Flexible 的实现。

## STARTUP I 与 STARTUP II 的真实含义

<!-- keywords: STARTUP I, STARTUP II, StartOS, RUN, Fixed -->

在 Fixed 状态机里，STARTUP I 表示操作系统启动前的基础初始化阶段，STARTUP II 表示 OS 已启动后由 EcuM 继续推进的阶段；二者之间隔着一次 StartOS。RUN 则是 Fixed 状态机中业务被允许运行的稳定状态。教学界面沿用这些标签只为讲解阶段感，它们不是 Flexible 必须存在的状态，也不应被当作统一的规范术语。

## InitTwo 与 InitThree 的旧职责

<!-- keywords: DriverInitTwo, DriverInitThree, InitThree, RTE, NvM -->

历史 Fixed 文档里，DriverInitTwo 与 DriverInitThree 承担不同职责，其中 InitThree 面向依赖已恢复 NvM 数据的模块；Fixed 甚至允许先启动带 STARTUP 模式的 RTE，再等待 NvM 并完成 InitThree。现代 Flexible 不要求实现这两个旧接口，因此不能假定一个现代 EcuM 必须调用 InitTwo 或 InitThree。

## 为何现代 EcuM 移除 Fixed 状态机

<!-- keywords: Flexible, R24-11, Post-Build, 状态机 -->

EcuM 规范在变更历史中记录了 Fixed 版本的移除，说明 R24-11 的 Flexible 不再沿用那套写死状态机。原因在于整车项目需要按配置裁剪启动顺序、支持多种变体与 Post-Build 选择，固定状态表难以覆盖。理解这一点，有助于避免在讨论现代 CP 平台时仍用 Fixed 的状态图去描述启动流程。

## 对照表不该当工程模板

<!-- keywords: EcuM, BswM, RTE, NvM, 对照表 -->

把 Fixed 与 Flexible 并排做成对照表便于教学，但对照表只是帮助记忆差异，不是可以直接照搬到项目的工程模板。真实集成要以所选版本的 EcuM、BswM、RTE 各 SWS 与配置生成结果为准。尤其在起步顺序、NvM 与 RTE 的先后以及业务放行条件上，每个项目的策略都可能不同，不能把一张教学表当作统一规范。

# EcuM_StartupTwo 与 StartOS 的边界

<!-- doc: startup-startuptwo-boundary -->
<!-- tags: EcuM_StartupTwo, StartOS, 启动钩子, 控制权 -->
<!-- summary: 解释 pre-OS 与 post-OS 两段为何不连续，以及 StartupTwo 到底完成什么、不完成什么。 -->
<!-- refs: src-ecum -->

StartOS 把启动切成两段，EcuM_StartupTwo 是接回控制权的那一步。这篇文档解释它由谁调用、完成什么，以及为什么它不在 EcuM_Init 的同一个调用栈里。

## EcuM_StartupTwo 由谁调用

<!-- keywords: EcuM_StartupTwo, EcuM_Init, StartOS, 自动启动, 启动钩子 -->

在典型的 Flexible 集成里，EcuM_StartupTwo 并不是在 EcuM_Init 的同一个调用栈里被调用；它通常由 OS 启动后自动运行的某个 OS 任务或启动钩子作为首个动作调回。控制权先由 StartOS 交给调度器，再通过一个自动启动实体回到 EcuM，完成 post-OS 部分。理解这条控制流，才能解释为什么 StartOS 之后不能再假设顺序代码继续往下执行。

## StartupTwo 到底做什么

<!-- keywords: EcuM_StartupTwo, SchM, BswM, RTE, 模式管理 -->

EcuM_StartupTwo 主要完成 post-OS 部分：对接模式管理、调用 SchM 启动序列、初始化和启动 BswM，并驱动 BSW 调度与时间基准开始运转。它不直接替应用恢复业务数据，也不决定应用何时上线；这些后续动作由 BswM 按规则与 RTE 生命周期推进。所以 StartupTwo 是接回控制权并拉起模式管理骨架的一步，而不是完成全部启动的一步。

## StartupTwo 与 BswM_Init 的关系

<!-- keywords: EcuM_StartupTwo, BswM_Init, BswM_MainFunction, NvM, RTE -->

EcuM_StartupTwo 往往并不亲自实现所有后启动逻辑，而是把控制交给 BswM_Init 与后续的模式处理。BswM_Init 按配置装载规则与初始模式，之后的 BswM_MainFunction 或事件驱动的模式切换才逐步触发 NvM 读取、通信许可、RTE 启动等动作。把 StartupTwo 理解成启动骨架的接续点，而不是所有模块的初始化总入口，可以避免在一个函数里塞满业务初始化。

## StartOS 之前不能做的事

<!-- keywords: StartOS, Cat2, 扩展任务, PLL, pre-OS -->

StartOS 之前，调度器、扩展任务、事件与 OS Alarm 都不可用，因此 pre-OS 代码不能等待事件、不能依赖周期任务推进，也不应依赖 Cat2 中断完成关键握手。需要异步完成的事情（例如等待 PLL 锁定、等待某驱动就绪）在 pre-OS 阶段必须用轮询或明确的同步确认处理，而不能假设会有中断或任务来推进。这是理解 EcuM 前后两段约束差异的核心。

## 启动交接与多核屏障的差别

<!-- keywords: StartCore, StartOS, 启动屏障, 多核, EcuM_StartupTwo -->

单核主线里，StartOS 之后由自动启动任务接回 EcuM_StartupTwo；多核系统还多出一层协调：主核调用 StartCore 启动其它核，被成功启动的核各自调用 StartOS，之后才可能通过启动屏障等待所有核到达就绪点。StartCore 不应在 StartOS 之后调用，被 StartCore 启动的核负责调用 StartOS。混淆单核交接与多核屏障，会误判启动到底卡在哪一层。

# BswM 模式仲裁规则

<!-- doc: startup-bswm-arbitration -->
<!-- tags: BswM, 模式管理, Rule, ActionList -->
<!-- summary: 讲清 BswM 如何接收模式请求、按规则求值并执行动作列表，以及它为何是上线放行的中枢。 -->
<!-- refs: src-bswm, src-mode-guide -->

BswM 是 BS 层决定「谁可以上线」的中枢。这篇文档讲清它如何接收模式请求、按规则求值、执行动作列表，以及为什么 BswM_Init 返回并不等于一切就绪。

## BswM 的职责

<!-- keywords: BswM, 模式请求, Rule, ActionList, EcuM -->

BswM（Basic Software Mode Manager）是 BS 层的模式仲裁与动作执行中心。它接收来自 EcuM、ComM、Dcm、NvM、Dem 等模块的模式请求，按配置的规则 Rule 评估条件，再执行动作列表 ActionList。BswM 本身不实现具体驱动或服务，而是把多个模块的模式状态汇总后，统一决定谁该放开、谁该等待，因此它是理解谁能上线的中枢。

## BswM_RequestMode 与规则求值

<!-- keywords: BswM_RequestMode, 规则, 模式条件, 动作列表, NvM -->

模块通过 BswM_RequestMode 之类的接口提交模式请求，BswM 把请求记录为规则输入。规则由逻辑表达式组合多个模式条件，例如 EcuM 处于 RUN 且 NvM 已完成且 ComM 请求了 FULL。当输入变化时 BswM 重新求值相关规则，条件由假变真就执行对应动作列表。求值顺序与触发时机由配置决定，因此同一组请求在不同配置下可能得到不同的最终模式。

## ActionList 里有什么

<!-- keywords: ActionList, ComM_CommunicationAllowed, ComM_RequestComMode, Rte_Start, 动作 -->

动作列表 ActionList 是一串按顺序执行的动作，常见动作包括调用 ComM_CommunicationAllowed 放开某通道许可、调用 ComM_RequestComMode 申请通信模式、触发 Rte_Start 或模式切换、启动或停止某模块的周期处理、通知 Dcm 切换诊断会话。动作可能立即执行也可能延迟到下一次 BswM 主函数，取决于配置的动作类型。理解动作列表，就能解释一次模式变化为何会引发一串下游动作。

## 规则求值顺序与确定性

<!-- keywords: BswM, 规则求值, 优先级, 确定性, 模式 -->

BswM 的规则求值需要可预期：多条规则可能同时被触发，执行顺序通常按配置的优先级或列表顺序确定，动作之间也可能互相影响输入，即一个动作改变的模式会成为另一条规则的输入。因此工程上要避免规则环与隐式依赖，明确谁先谁后。教学仿真里每次模式变化都能确定性回放，也正依赖这种规则输入、求值、动作的确定顺序。

## BswM_Init 与初始模式

<!-- keywords: BswM_Init, 初始模式, 规则求值, 通信许可, RTE -->

BswM_Init 负责装载规则与初始模式，但它本身并不等于所有规则都已评估一遍。初始化后 BswM 依据初始模式与后续请求逐步评估规则，因此系统可能先处于一个保守的中间状态：例如通信许可尚未放开、RTE 尚未启动。把 BswM_Init 返回当作一切就绪是常见的误读；真正的放行要靠后续规则求值与动作执行来完成。

## BswM 如何用 NvM 完成推进启动

<!-- keywords: NvM, BswM, 规则, RTE, 多块读取 -->

一个典型的后启动例子是：NvM 完成多块读取后，通过配置的接口向 BswM 反馈作业状态，BswM 的某条规则据此由数据未就绪转为数据就绪，动作列表于是允许 RTE 启动或业务模式切换。这解释了为什么 NvM 读完不等于业务已经上线：中间还隔着 BswM 的规则评估与动作执行，二者是不同层次的放行。

# RTE 启动流程与通信范式

<!-- doc: startup-rte-lifecycle -->
<!-- tags: RTE, Rte_Start, sender/receiver, client/server -->
<!-- summary: 分清 Rte_Start、InitContainer 与 Rte_StartTiming，并说明两种通信范式与事件触发。 -->
<!-- refs: src-rte -->

Rte_Start、初始化容器与 Rte_StartTiming 常被混为一谈。这篇文档按顺序把它们拆开，并说明两种通信范式如何被事件触发成 runnable。

## Rte_Start 的职责

<!-- keywords: Rte_Start, RTE, runnable, SWC, 通信端口 -->

Rte_Start 初始化 RTE 运行环境，包括通信端口、触发缓冲以及 RTE 内部数据结构，使 SWC 之间以及 SWC 与 BSW 之间可以通过 RTE 交互。它安排的是 RTE 自身的就绪，而不是应用 runnable 何时被调度执行。把 Rte_Start 视为应用开始运行是常见的误读：真正让周期或事件 runnable 开始执行的是后续的计时与调度启动。

## Rte_Init 与 InitContainer

<!-- keywords: Rte_Init, InitContainer, 初始化 runnable, SWC, RTE -->

Rte_Start 之后，RTE 生成代码通常会调用 Rte_Init_<InitContainer> 之类的初始化容器，按配置批次调用各 SWC 的初始化 runnable。InitContainer 的名字由项目生成，指南里的 Rte_Init 只是简称。初始化 runnable 负责把 SWC 的内部状态摆到已知初值，但它们仍不等同于业务已经开始周期处理。理解这一层，能避免把初始化与周期调度混为一谈。

## Rte_StartTiming 才放开周期与后台

<!-- keywords: Rte_StartTiming, Rte_Start, 周期触发, 后台事件, runnable -->

Rte_StartTiming 负责放开 RTE 的计时机制，使周期触发、后台事件等按配置开始生效。也就是说 Rte_Start 让 RTE 就绪，Rte_StartTiming 让时间驱动的 runnable 真正开始跑。若业务依赖尚未恢复的持久数据，可以在数据就绪后再调用计时启动，或在 runnable 内检查数据有效性，这正是教学配置采用数据门控的根据。

## sender/receiver 与 client/server

<!-- keywords: sender/receiver, client/server, operation, runnable, 事件 -->

RTE 提供两类主要通信范式：sender/receiver 用于数据分布，发送端写数据、接收端读最新值或接收队列项；client/server 用于服务调用，client 发起同步或异步的 operation，server runnable 响应并返回结果。两者的触发与缓冲语义不同，sender/receiver 常与 dataReceived 事件或显式读取配合，client/server 则与 operationInvoked 事件、异步结果返回配合。选错范式会带来不必要的阻塞或数据丢失。

## RTE 事件与触发

<!-- keywords: RTE 事件, dataReceived, operationInvoked, timingEvent, runnable -->

RTE 事件把底层发生的事实转成 runnable 的触发：dataReceived 表示收到新数据、operationInvoked 表示有服务调用、modeSwitch 表示模式切换、timingEvent 表示周期到点。事件可以激活任务（在 OS 下映射为 SetEvent），也可以直接映射为 runnable 的激活。理解事件到 runnable 的映射，才能解释一次通信到达为什么最终变成某个函数被执行。
