# UDS 诊断实验台：学习指南

点击页面顶部的「UDS 诊断与刷写」切换到完整诊断工作区。它与整车仿真共用 ECU 状态：只有目标 ECU 的 DCM 已初始化、CAN 实际进入 `FULL_COM`、发送许可有效且网关路由可达时，诊断请求才会到达服务层。这样可以同时学习“诊断服务怎么响应”和“请求为什么根本没有响应”。Gateway、Powertrain、Chassis、Body 各自拥有独立会话、DTC 与刷写状态；切换工作区或目标 ECU 时不会丢失。

这是确定性的教学模型，不是 ISO 14229 一致性实现、商业 AUTOSAR DCM、真实诊断仪或安全产品。CAN ID、DID、DTC、权限、Seed/Key、S3、安全延迟、P2/P2* 数值和例程均为本项目示例配置。

## 先建立协议栈视角

一次请求在本实验中的路径是：

```text
Tester request
  → CAN ID 0x7E0
  → CanIf / CanTp（单帧或多帧）
  → PduR / Dcm
  → Service handler / Dem
  → CanTp / CAN ID 0x7E8
  → Tester response
```

UDS 负责服务语义；CanTp 负责把超过单个经典 CAN 数据帧容量的诊断消息分段和重组。实验台会把每次事务展开成 `SF`、`FF`、`FC`、`CF`，便于观察传输层与应用层不是同一件事。[AUTOSAR DCM R24-11][dcm]、[AUTOSAR CanTp R24-11][cantp]

## 推荐的四步路径

### 1. 读取 VIN：认识 SID、DID 和多帧

1. 点击「运行 ECU 到 RUN」。
2. 发送 `22 F1 90`。
3. 找出请求 SID `22`、正响应 SID `62` 和被原样回显的 DID `F1 90`。
4. 在 ISO-TP 表中观察响应的 `FF → FC → CF`。

VIN 比一个经典 CAN 单帧的 UDS 负载更长，所以 ECU 必须先发 First Frame，诊断仪再发 Flow Control，ECU 继续发 Consecutive Frame。这里的 VIN 是虚构教学数据。

### 2. 会话控制：理解访问权限

在默认会话直接发送 `14 FF FF FF`，应得到负响应：

```text
7F 14 7E
│  │  └─ NRC：当前会话不支持该 sub-function
│  └──── 原请求 SID
└─────── NegativeResponse SID
```

然后发送 `10 03` 进入扩展会话。正响应以 `50` 开头，即请求 SID `10 + 0x40`。实验台顶部也提供三种会话的快捷切换：默认会话 `10 01`、编程会话 `10 02`、扩展会话 `10 03`；点击后会立即发送请求。实验中的 P2/P2* 数值只是示例，不应当当作真实 ECU 的时间参数。

### 3. SecurityAccess：观察有顺序的状态机

1. 发送 `27 01` 请求 Seed。
2. 点击「填入教学 Key」。
3. 发送自动填入的 `27 02 ...`。
4. 观察状态从 `LOCKED` 变成 `UNLOCKED`。

可故意发送错误 Key 观察 `NRC 35`；连续三次错误后进入教学延迟状态，后续得到 `NRC 37`。点击「重置诊断状态」恢复。

这里的 Key 算法被刻意公开并保持简单，只用于让状态变化可观察。它没有密码学安全性，绝不能用于真实 ECU、课程项目之外的设备或任何量产密钥设计。

### 4. DTC：联系 DCM 与 Dem

发送 `19 02 FF` 读取所有示例状态的 DTC。正响应中每条记录是“三字节 DTC + 一字节状态”，页面同时给出便于学习的中文故障描述。

要清除 DTC：先进入扩展会话、完成安全解锁，再发送 `14 FF FF FF`。如果顺序不对，分别观察会话或安全前提导致的 NRC。服务正响应会立即更新当前 Dem 教学状态，但掉电保持仍要经过共享存储实验中的 NvM 异步队列；可以切到「存储实验室」观察 `NvM → MemIf → Fee → Fls → verify → commit`。

## 服务目录

| 请求 | 学习目标 | 本实验的主要前提 |
| --- | --- | --- |
| `10 01/02/03` | DiagnosticSessionControl | 选择默认、编程、扩展会话 |
| `22 F1 90` | ReadDataByIdentifier | 读取示例 VIN；无需解锁 |
| `27 01` / `27 02 + key` | SecurityAccess | 扩展或编程会话；Seed 先于 Key |
| `19 02 FF` | ReadDTCInformation | 读取示例 DTC 与状态 |
| `14 FF FF FF` | ClearDiagnosticInformation | 扩展/编程会话 + 解锁 |
| `2E F1 A0 + 4 bytes` | WriteDataByIdentifier | 扩展/编程会话 + 解锁 |
| `31 01 02 03` | RoutineControl | 编程会话 + 解锁 |
| `34 00 44 + address + size` | RequestDownload | 编程会话 + 解锁 + 先擦除非活动分区 |
| `36 counter + data` | TransferData | 已接受下载请求；块序号与总长度必须正确 |
| `37` | RequestTransferExit | 所有声明字节已完成传输 |
| `3E 00` / `3E 80` | TesterPresent | 响应或抑制正响应，记录 S3 刷新概念 |
| `B0/B1/B2 ...` | 虚构 OEM 私有服务 | 各自仍受长度、会话、安全和范围检查 |

还可以发送未实现的 SID 或 DID，观察 `NRC 11`、`NRC 31`；发送长度错误的请求，观察 `NRC 13`。页面记录最近 40 条事务，负响应也是学习材料。

## 虚拟时间、S3 与 NRC 78

非默认会话会启动 5 s 的教学 S3 倒计时。只有推进共享虚拟时间才会减少计时；发送 `3E 00` 或抑制正响应的 `3E 80` 都会刷新它。打开顶部“自动 3E（2 s）”可让当前 ECU 周期发送 TesterPresent，关闭后继续推进时间则会回到默认会话并锁定安全等级。

连续三次错误 Key 会进入 3 s 教学安全延迟，在到期前请求 Seed 得到 `NRC 37`。刷写中的 `31 01 FF 00` 则先返回 `NRC 78 · ResponsePending`；250 ms 虚拟擦除完成后，事务历史出现最终 `71 01 FF 00 00`。等待期间不会提前把目标分区标记为已擦除。

这些计时用来呈现状态机边界，并不是量产 DCM 的线程调度或真实 P2/P2* 测量。

## Classic CAN 与 CAN FD

顶部“CAN FD 诊断”会让当前 ECU 的 UDS 交换使用 64 字节教学数据帧。较长响应通常能用更少的 ISO-TP 帧，但 CAN FD 不会消除消息长度、顺序、Flow Control 与超时概念。若要逐帧观察 Block Size、STmin、丢 FC、丢 CF 和错误序号，请切到「通信与网络管理」中的独立 ISO-TP 传输台。

## 教学刷写：从下载请求到分区激活

实验台内置两份很小的确定性镜像：Application v1.2.0（48 字节）和 Calibration 2026.08（32 字节）。它们只是浏览器内存中的字节数组，不读取本机文件，也不会写入磁盘、真实 ECU 或 Flash。

点击「准备刷写」会自动完成编程会话与教学 SecurityAccess；随后可以逐步执行每个请求，也可以点击「自动完成」。完整路径是：

```text
10 02                         进入编程会话
27 01 / 27 02 + key          完成教学安全访问
31 01 FF 00                  擦除非活动分区（项目例程）
34 00 44 + address + size    RequestDownload
36 counter + data            一个或多个 TransferData 块
37                            RequestTransferExit
31 01 FF 01 + CRC32          校验镜像（项目例程）
31 01 FF 02                  激活非活动分区（项目例程）
```

`0x36` 的块序号必须从 1 连续递增；跳块会得到 `NRC 73`。未声明下载就发送数据、镜像未收完整就结束、未校验就激活，会得到 `NRC 24`。CRC 错误会得到 `NRC 72`，活动分区和版本不会改变。

AUTOSAR DCM R24-11 将 `0x34` 定义为启动下载过程，并要求 `0x36` 之前已经存在有效的 RequestDownload 或 RequestUpload；`0x37` 用来终止下载/上传过程。[AUTOSAR DCM R24-11][dcm] 本实验在此基础上增加了虚构的 `FF00/FF01/FF02` 项目例程，以呈现常见的擦除、校验和激活阶段，但不声称它们是标准例程 ID。

真实安全刷写至少还要考虑供电条件、Flash 驱动、掉电恢复、签名与证书链、安全启动、防回滚、兼容性、Bootloader 跳转、真实 P2/P2* 调度、传输超时和失败回滚。本实验只用可确定的 NRC 78 擦除等待来帮助理解协议顺序与状态门控。

## 虚构 OEM 私有服务

私有服务区提供三条完全虚构的请求：

- `B0 01`：读取当前活动分区和软件版本，默认会话可用。
- `B1 01`：读取教学供电电压与温度，需要扩展或编程会话。
- `B2 A5 01 01`：控制示例特性，需要扩展/编程会话、安全解锁和项目令牌。

这些 SID 和数据编码不对应任何真实汽车厂商。`A5` 是公开教学常量，不是密钥。重点是练习：即使服务语义由项目自己定义，也不应该跳过 DCM 的消息长度、会话、安全、顺序和参数范围检查。

## 用故障场景学习“无响应”

切换主界面到 `CAN Bus-Off` 场景，再在实验台运行到 RUN 并发送 `22 F1 90`。应用仍可进入 RUN，但诊断实验台应显示“诊断 CAN 链路不可用”，且没有伪造响应帧。

这是很重要的边界：`7F xx yy` 是 ECU 确实发送的 UDS 负响应；Bus-Off、线束断开、寻址不匹配或 CanTp 超时导致的无响应属于传输/通信问题，不能随意解释成某个 NRC。

## 继续扩展时从哪里下手

- 协议与状态机在 [`src/uds.mjs`](../src/uds.mjs)，可以先新增 DID 或调整访问矩阵。
- UI 联动在 [`src/app.mjs`](../src/app.mjs)，协议模型不依赖 DOM，可直接用 Node 测试。
- 回归用例在 [`tests/uds.test.mjs`](../tests/uds.test.mjs)。新增服务时先写正响应、NRC 和传输分帧测试。
- 当前导出 JSON 会包含 `uds` 快照，可比较会话、安全状态、DTC 和事务历史。

下一阶段如果要更接近工程实践，建议依次加入功能寻址与抑制规则、可配置 P2/P2* 服务调度、多级安全访问、传输层并发、签名/防回滚教学模型和 DoIP；每次只扩一条可测试链路，不要把教学配置误写成通用 AUTOSAR 配置。

[dcm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DiagnosticCommunicationManager.pdf
[cantp]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_CANTransportLayer.pdf
