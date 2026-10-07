# 我做了一个零依赖的 AUTOSAR CP 交互式实验室：从 ECU 启动到 UDS、CAN NM、NvM、OS 与 XCP

> **CSDN 发布信息（发布时可删除本段）**
>
> 分类建议：汽车电子 / 嵌入式 / AUTOSAR
>
> 标签建议：`AUTOSAR`、`UDS`、`CAN`、`ECU`、`汽车电子`
>
> 摘要：本文介绍一个独立开发、可在浏览器中运行的 AUTOSAR Classic Platform 交互式学习实验室。项目用四个共享虚拟时钟的教学 ECU，把启动流程、UDS 与刷写、CDD、多 ECU、CAN NM、NvM/Fee、OS 多核调度和 XCP 在线标定连接成了可单步、可回放、可注入故障的行为仿真。

学习 AUTOSAR 时，我经常遇到一个问题：资料里的每个模块单独看都能理解，但把它们放到一条真实的启动和运行链路中，就很容易失去整体视角。

例如：

- MCU、Port、OS、EcuM、BswM、RTE 到底按照什么依赖关系启动？
- `NvM_ReadAll()` 返回以后，数据是否已经真的可用？
- `ComM_RequestComMode()` 返回 `E_OK`，是否代表 CAN 已经进入 `FULL_COM`？
- UDS 为什么有时返回 NRC，有时却完全没有响应？
- 编程会话、Seed/Key、擦除、下载、校验和分区激活是什么关系？
- CDD、多 ECU 和多核架构看起来都像“多个方框”，它们的边界究竟有什么不同？
- 网络释放后，CAN NM 为什么不会立刻进入 BUS_SLEEP？
- NvM 写请求、Fee/Fls 操作和真正的掉电保持之间隔着哪些阶段？
- OS 抢占、Cat1/Cat2 中断、IOC、Spinlock 和 XCP DAQ 如何影响运行期行为？

为了把这些分散的知识串起来，我独立开发了一个 **AUTOSAR CP Architecture Framework Laboratory**。它不是静态流程图，而是一个可以播放、暂停、单步、回退、设置断点和注入故障的交互式实验环境。

项目地址：

[https://github.com/yeyue1/Autosar-CP-Architecture-Framework-Laboratory](https://github.com/yeyue1/Autosar-CP-Architecture-Framework-Laboratory)

## 一、这个项目是什么？

这是一个面向 AUTOSAR Classic Platform 的教学级行为仿真项目，包含七个同级工作区：

| 工作区 | 主要内容 |
| --- | --- |
| 启动流程 | 7 个阶段、42 个教学步骤、模块高亮、任务时序、日志、CAN 报文和故障场景 |
| UDS 诊断与刷写 | 会话控制、SecurityAccess、DID、DTC、NRC、ISO-TP、刷写状态机和虚构 OEM 私有服务 |
| 系统架构 | CDD 深入、多 ECU 协同、多核启动、实例所有权、同步关系与故障门控 |
| 通信与网络管理 | 应用信号、CAN PDU、NM 休眠/唤醒、共享总线与 ISO-TP / CAN FD |
| 存储实验室 | NvM、MemIf、Fee、Fls、提交边界、CRC、写保护、掉电恢复与 GC |
| OS 与多核调度 | 固定优先级抢占、Cat1/Cat2 ISR、扩展任务、IOC、Spinlock 和核上下线 |
| XCP 在线标定 | 连接、DAQ、RAM 参数、控制响应曲线与经 NvM 保存的掉电保持 |

这七个工作区不是几个小弹窗，而是七个完整界面。Gateway、Powertrain、Chassis、Body 四个教学 ECU 共享一条虚拟时间轴，但各自拥有独立的启动、UDS、DTC、NvM 和 XCP 状态；切换工作区或诊断目标时，状态不会凭空重置。

项目不依赖前端框架，也没有第三方运行时包。只要安装 Node.js 20 或更新版本，就可以在本机启动。

> 建议配图 1：在这里插入项目的七个顶部工作区和共享整车控制条截图。

## 二、把 AUTOSAR 启动流程变成可调试的时间线

启动实验室把一次 ECU 上电过程拆成 7 个阶段、42 个教学步骤。这里的“42 步”是为了观察依赖关系而设计的教学粒度，并不是 AUTOSAR 规范规定的固定步骤数量。

整个控制权交接可以简化为：

```text
Reset / C Runtime
        ↓
EcuM early startup
        ↓
MCAL 与基础驱动初始化
        ↓
StartOS
        ↓
EcuM post-OS startup
        ↓
SchM / BswM / NvM / ComM 等 BSW 协同
        ↓
RTE 与应用进入可运行状态
```

在界面中，每执行一步都能同时看到：

- 当前调用者、目标模块和协作模块；
- 对应的软件分层与模块高亮；
- 当前 EcuM、OS、RTE、NvM、ComM 和 CAN 状态；
- 教学伪代码与中文解释；
- 虚拟时间、周期任务、应用信号和总线记录；
- 该步骤依赖的前置条件以及产生的状态变化。

我还加入了执行前断点。比如可以把断点放在 `StartOS` 前，观察控制权从 EcuM 交给 OS 前后发生了什么；也可以停在 `NvM_ReadAll` 附近，对比“请求已经受理”和“数据已经就绪”这两个完全不同的状态。

### 五个内置故障场景

单纯看正常流程很容易形成错误直觉，所以实验室加入了五个可切换场景：

1. **正常启动**：所有前置条件满足，最终进入 RUN。
2. **PLL 锁定失败**：时钟条件不成立，启动在进入 OS 前阻塞。
3. **NvM 读取偏慢**：`ReadAll` 已发起，但系统必须继续等待异步结果。
4. **NvM CRC 失败**：记录异常并使用 ROM 默认值，再按教学策略降级继续。
5. **CAN Bus-Off**：应用可以进入 RUN，但通信实际模式停留在 `SILENT_COM`，系统不会伪造发送成功的报文。

这几个场景想表达的是：AUTOSAR 启动不是简单的 API 调用清单，而是一组带前置条件、异步完成和降级策略的状态机。

> 建议配图 2：在这里插入启动时间线、模块高亮和故障场景截图。

## 三、UDS 不只是“发一串十六进制”

第二个工作区是完整的 UDS 诊断与刷写实验台。请求不会直接进入某个服务函数，而是沿着一条简化但清晰的协议路径传递：

```text
Tester
  → CAN / ISO-TP
  → CanIf
  → CanTp
  → PduR
  → Dcm
  → Dem / NvM / 应用数据 / 刷写状态机
```

只有启动侧的 DCM 已完成初始化、CAN 实际进入 `FULL_COM`，并且发送条件满足时，请求才能真正到达诊断服务层。

这使实验室能够区分两个经常被混淆的概念：

- `7F xx yy`：ECU 已经收到请求，并明确返回了一条 UDS 负响应；
- 完全没有响应：可能是 Bus-Off、寻址不匹配、CanTp 超时或请求根本没有到达 DCM。

### 1. 会话模式如何切换？

实验台支持三种常见会话快捷切换：

```text
10 01    默认会话
10 02    编程会话
10 03    扩展会话
```

正响应的 SID 是请求 SID 加 `0x40`，例如 `10 02` 的正响应以 `50 02` 开头。

如果收到：

```text
7F 10 7E
```

其中 `0x7E` 表示 `SubFunctionNotSupportedInActiveSession`，也就是当前会话不允许这个子功能。真实项目中，会话切换还可能受到车辆状态、电压、速度、点火状态、Bootloader 能力和 OEM 配置限制；它并不是只要发送 `10 02` 就一定成功。

### 2. 读取 DTC 一定要先解锁吗？

不一定。

`19 02 FF` 是按状态掩码读取 DTC。很多项目允许在默认会话直接读取部分 DTC，不要求先完成 Seed/Key；但清除 DTC、写 DID、例程控制或刷写通常会有更严格的会话和安全等级限制。最终权限由具体 ECU 的 DCM 配置和 OEM 诊断规范决定。

实验室特意把“读取”和“清除”分开：读取 DTC 可以直接练习，而清除 DTC 需要先进入扩展会话并完成教学安全解锁，从而观察不同服务的访问条件。

### 3. 为什么一条 UDS 响应会出现多帧？

经典 CAN 一帧最多承载 8 字节，诊断有效载荷通常不能全部放进去。因此较长的 `0x19` 或 `0x22` 响应会通过 ISO-TP 拆成：

```text
FF（First Frame）
FC（Flow Control）
CF（Consecutive Frame）
CF
...
```

所以界面右侧看到多条 TX/RX，并不是服务被重复执行，而是一次 UDS 消息的分段、流控与重组过程。

CAN FD 可以让单帧数据区扩展到最多 64 字节，确实能显著减少分帧次数；但当诊断消息仍然大于单帧可用空间时，ISO-TP 依旧有存在的必要。实验室提供 Classic CAN / CAN FD 切换，可以对照相同负载的帧数，并单步观察 `SF/FF/FC/CF`、流控和超时。

## 四、把刷写做成一条有门控的状态机

刷写不是连续发送若干 `0x36` 数据块这么简单。实验室实现的教学路径是：

```text
10 02                       进入编程会话
27 xx                       SecurityAccess
31 01 FF00                  擦除非活动分区（教学例程）
34 ...                      RequestDownload
36 01 ...                   TransferData，第 1 块
36 02 ...                   TransferData，第 2 块
...                         按序传输
37                          RequestTransferExit
31 01 FF01 ...              CRC32 校验（教学例程）
31 01 FF02                  激活新分区（教学例程）
```

这里使用双分区模型：当前活动分区继续保留，新镜像先写入非活动分区；只有传输完整且 CRC 校验通过以后，才能切换活动版本。

为了让错误路径也能被观察，状态机会拒绝以下操作：

- 未进入编程会话就开始下载；
- 未解锁就执行受保护操作；
- 未擦除目标区域就请求下载；
- `TransferData` 块序号不连续；
- 镜像尚未收完整就退出传输；
- CRC 错误时激活新分区；
- 未校验就直接激活。

实验室还提供两份确定性的教学镜像，可以选择手动单步，也可以自动完成整条刷写流程。

需要强调的是，真实量产刷写还要处理 Flash Driver、供电条件、掉电恢复、签名与证书链、安全启动、防回滚、兼容性、Bootloader 跳转、超时和失败回滚。本项目只模拟协议顺序、数据传输和状态门控。

> 建议配图 3：在这里插入 UDS 会话、ISO-TP 传输帧和刷写进度截图。

## 五、为什么还要加入私有协议？

量产项目不可能只有标准 UDS 服务，通常还会出现 OEM 或供应商自定义能力。实验室加入了三条**完全虚构**的私有服务，用来说明一个核心思想：

> 私有协议可以自定义业务语义，但不能绕过基本的会话、安全、长度、顺序和范围检查。

通过这些服务可以练习：

- 如何设计自定义 SID 和请求格式；
- 如何为私有服务配置允许会话；
- 如何复用 SecurityAccess 结果；
- 如何返回合理的 NRC；
- 如何避免把任意内存读写暴露给诊断端。

这些请求没有对应任何真实厂商协议，也不包含量产密钥或专有实现。

## 六、CDD、多 ECU 和多核不是同一件事

系统架构工作区关注设计层关系，包含三个可以独立播放和注入故障的实验。

### 1. CDD 深入

CDD（Complex Device Driver）常用于标准 MCAL 或 BSW 难以覆盖的特殊硬件能力，但“接近硬件”并不代表可以无约束地访问一切。

CDD 实验展示了：

- 特殊 ASIC 的初始化和自检；
- 寄存器、IRQ、DMA 等资源的所有权；
- SchM/OS 临界区对共享资源的保护；
- 通过 EcuM/BswM 管理模式；
- 使用 Det/Dem 上报错误；
- 自检失败后为什么不能向 RTE 发布无效数据。

### 2. 多 ECU 协同

多 ECU 指多个独立 MCU 和故障域。每个 ECU 都有自己的启动过程、OS、通信状态和复位行为，它们通过 CAN 等车载网络协同。

因此，本地 ECU 已进入 RUN，不代表远端 ECU 已经上线；网关已经启动，也不代表所有路由目标都可用。实验中的故障注入可以观察单个 ECU 缺席时，系统如何超时并收敛到降级状态。

### 3. 多核启动

多核则发生在同一个 ECU、同一个多核 MCU 内。不同核心通常共享部分硬件和软件镜像，但各自拥有任务、栈、中断和 OS 运行数据。

实验路径重点展示：

```text
Core 0 reset
  → 初始化共享时钟与 RAM
  → StartCore(1/2)
  → 各核心 StartOS
  → OS-Application 初始化
  → SchM / IOC 建立
  → startup barrier
  → RTE / BSW 事件放行
```

其中：

- IOC 用于同核或跨核 OS-Application 通信；
- Spinlock 用于保护多核共享资源；
- startup barrier 用于保证关键核心都达到预定同步点；
- 任意关键核心未就绪时，不应假装整个系统已经启动完成。

一句话概括：多 ECU 的核心问题是**网络协同与独立故障域**，多核的核心问题是**共享资源、核归属与同步**。

> 建议配图 4：在这里插入 CDD、多 ECU 拓扑和多核启动屏障截图。

## 七、把运行期模块放进同一辆“虚拟车”

如果启动、诊断、存储和通信各自运行在互不关联的小 Demo 中，很多工程因果关系仍然看不到。因此项目现在使用一条共享虚拟时钟驱动四个教学 ECU，并增加四个完整的运行期工作区。

### 1. CAN NM 与 ISO-TP / CAN FD

在“通信与网络管理”中，可以释放全部 ComM 网络请求，然后推进时间观察：

```text
REPEAT_MESSAGE
  → NORMAL_OPERATION / READY_SLEEP
  → PREPARE_BUS_SLEEP
  → BUS_SLEEP
```

其他节点的 NM 报文会刷新超时，网络唤醒又会把节点带回 Repeat Message。应用信号则沿 `SWC → RTE → Com → PduR → CanIf → Can Driver` 映射到教学 CAN 字节。

同一页还提供独立的 ISO-TP 逐帧传输台。相同负载可以在 Classic CAN 与 CAN FD 间切换，并注入丢失 FC、丢失 CF、错误序号等故障。CAN FD 能减少帧数，但不会取消 ISO-TP 的顺序、流控和超时语义。

### 2. NvM / Fee 与掉电恢复

存储实验室把一次写入拆成可见流水线：

```text
NvM → MemIf → Fee → Fls → verify → commit
```

`NvM_WriteBlock` 被接受时，持久化值仍然不变。只有走到 `commit` 后，新记录才成为掉电恢复的数据源。可以在任意阶段断电，也可以注入 CRC 错误、打开写保护或连续写入触发双扇区 GC。

诊断产生的 DTC 和 XCP 保存的标定值也复用同一个存储模型，因此可以从一个工作区制造数据，再到另一个工作区验证其生命周期。

### 3. OS 多核调度

调度实验用 1 ms 粒度展示固定优先级抢占、周期任务、高优先级诊断任务、Cat1/Cat2 ISR、扩展任务事件、IOC 消息、Spinlock 竞争和核心上下线。它不是一个真实 AUTOSAR OS，但能把“任务属于哪个核”“谁抢占谁”“中断返回后发生什么”“关键核心离线后屏障是否放行”变成可观察状态。

### 4. XCP 在线标定

XCP 工作区模拟连接、DAQ 和 RAM 标定工作流。修改 Gain、Filter、Threshold 后，传感器、滤波值和执行器输出会立即形成新的控制响应；启动 DAQ 后，每 10 ms 留下一个测量样本。RAM 修改不会自动掉电保持，只有“保存标定到 NvM”并等待提交后，复位才会恢复新值。

> 建议配图 5：在这里插入 NM 状态、NvM 流水线、多核时间线和 XCP 曲线的组合截图。

## 八、项目内部是怎么实现的？

这个项目没有尝试执行真实 ECU 固件，而是使用确定性的离散状态模型描述每一步的前置条件、状态变化和可观察结果。

核心文件职责如下：

| 文件 | 作用 |
| --- | --- |
| `src/model.mjs` | 启动阶段、42 个步骤、模块、场景和任务参数 |
| `src/engine.mjs` | 状态转移、故障策略、虚拟任务调度和总线事件 |
| `src/player.mjs` | 播放、暂停、速度、断点、回退和确定性重放 |
| `src/uds.mjs` | UDS、ISO-TP、DTC、SecurityAccess、刷写与私有服务 |
| `src/system-lab.mjs` | CDD、多 ECU、多核 profile 和独立状态机 |
| `src/vehicle.mjs` | 四 ECU、共享时钟、诊断路由、NM、应用 PDU、CDD 与跨模块状态编排 |
| `src/storage.mjs` | NvM/MemIf/Fee/Fls、CRC、写保护、掉电恢复与双扇区 GC |
| `src/transport-lab.mjs` | Classic CAN / CAN FD ISO-TP、FC、STmin、序号与超时故障 |
| `src/os-lab.mjs` | 多核任务、抢占、中断、IOC、Spinlock 与时间线 |
| `src/xcp-lab.mjs` | XCP 连接、DAQ 和 RAM 标定状态机 |
| `src/module-guide.mjs` | 模块生命周期、上下游关系和跨层软件路径 |
| `src/extended-ui.mjs` | 通信、存储、调度、标定和整车实例视图 |
| `src/app.mjs` | 七个工作区的状态编排、渲染与交互 |

模型层与界面层分离后，可以先在 Node.js 中验证状态机，再把结果渲染到浏览器。这样做还有一个好处：同一个输入和场景可以得到确定性的回放结果，便于编写回归测试。

目前项目包含 107 项自动化测试，覆盖：

- 正常启动和故障阻塞；
- NvM 异步语义；
- 通信请求模式与实际模式分离；
- 播放、断点、回退和确定性重放；
- UDS 正负响应与 ISO-TP 分帧；
- Seed/Key 错误和延迟状态；
- 刷写顺序、块序号、CRC 与分区激活；
- CDD、多 ECU、多核故障门控；
- 四 ECU 独立诊断、网关路由、NM 休眠/唤醒和节点超时 DTC；
- NvM 提交边界、断电、CRC、写保护与 GC；
- CAN FD/Classic CAN ISO-TP 容量、流控、序号和超时；
- OS 抢占、中断、IOC、锁竞争与 XCP DAQ/标定持久化；
- 本地服务器路径与访问边界。

## 九、如何运行？

环境要求：Node.js 20 或更新版本。

```bash
git clone https://github.com/yeyue1/Autosar-CP-Architecture-Framework-Laboratory.git
cd Autosar-CP-Architecture-Framework-Laboratory
npm start
```

然后在浏览器打开：

```text
http://127.0.0.1:4173/
```

项目没有第三方 npm 依赖，因此不需要先执行 `npm install`。Windows 用户也可以直接双击 `start.cmd`。

不要直接双击 `index.html`，因为浏览器需要通过本地 HTTP 服务加载 ES Modules。

### 运行完整验证

```bash
npm run verify
```

### 在命令行导出一次启动轨迹

```bash
npm run trace -- --scenario normal --duration 250
```

## 十、推荐的学习顺序

如果刚开始接触 AUTOSAR，可以按照下面的顺序使用：

1. 用正常场景完整播放一次启动过程。
2. 在 `StartOS` 前设置断点，观察控制权边界。
3. 对比 NvM 慢读与 CRC 失败，理解异步完成和默认值降级。
4. 对比正常通信与 Bus-Off，区分“请求成功”和“实际模式完成”。
5. 在 UDS 工作区读取 VIN 和 DTC，观察 ISO-TP 多帧。
6. 依次尝试默认、扩展和编程会话，再完成 Seed/Key。
7. 手动完成一次刷写，再故意打乱步骤观察 NRC。
8. 在通信工作区释放全部网络请求，观察 NM 休眠；再比较 Classic CAN 与 CAN FD 的 ISO-TP 帧数。
9. 在存储工作区分别于 `commit` 前后断电，确认何时才真正掉电保持。
10. 在 OS 工作区注入 Cat2 中断与锁竞争，再到 XCP 工作区修改 RAM 标定并保存到 NvM。
11. 进入系统架构工作区，比较 CDD、多 ECU 和多核的所有权边界。
12. 修改一个模型参数，运行测试并观察界面变化。

## 十一、项目边界

最后必须说明：这个项目是**教学级行为仿真**，不是商业 AUTOSAR 工具，也不是可以直接烧录到硬件的 ECU 工程。

它不提供：

- 量产 BSW、MCAL、RTE 或 ARXML 生成；
- 真实 ECU C 固件执行；
- 物理 CAN、真实中断和 MCU 寄存器；
- 量产 Seed/Key、签名密钥或 OEM 私有协议；
- 功能安全认证或诊断一致性认证；
- 可直接用于量产的多核 OS 和多 ECU 配置。

项目选择 AUTOSAR CP R24-11 作为固定的技术核对基线，但界面中的阶段划分、时间、任务、CAN ID、DID、DTC、镜像和错误策略都是教学配置。真实项目仍然必须结合 MCU、BSW 供应商、OS、配置工具和 OEM 规范进行设计。

## 结语

我希望这个实验室解决的，不是“记住更多 AUTOSAR API”，而是建立三个更重要的工程直觉：

1. **调用返回不等于状态已经完成。**
2. **模块启动不等于系统功能已经放行。**
3. **正常路径之外，故障、超时和降级路径同样属于架构。**

如果你也在学习 AUTOSAR、UDS、ECU 刷写或多核架构，欢迎下载运行、修改模型或补充测试。

GitHub：

[https://github.com/yeyue1/Autosar-CP-Architecture-Framework-Laboratory](https://github.com/yeyue1/Autosar-CP-Architecture-Framework-Laboratory)

如果这个项目对你有帮助，也欢迎点一个 Star。

---

**声明：本项目为独立编写并公开展示的教学实现，不包含任何整车厂、供应商或商业 AUTOSAR 工具的源码、配置、密钥及私有协议。**
