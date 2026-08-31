# 资料来源与复现边界

核对日期：2026-08-28。

本项目的技术基线是 **AUTOSAR Classic Platform R24-11 的 EcuM Flexible 启动机制**，并选择了一组便于观察依赖关系的教学配置。它不是某供应商 BSW 的复刻，不构成 AUTOSAR 一致性实现。官网当前发布版为 R25-11；选择 R24-11 是为了固定、可核对的教学基线，不代表它是最新版。[官网发布信息][current]

## 官方技术资料

下表只列本次实际用于核对的资料。章节号和 `SWS_*` 标识便于在 PDF 中搜索；这不是对全部规范的逐页审阅。`SWS` 是软件规范，`EXP` 指南中的例子不能直接当成所有 ECU 的唯一初始化顺序。

| 资料 | 版本与定位 | 用于核对的内容 |
| --- | --- | --- |
| [ECU State Manager SWS][ecum] | R24-11；§7.3.1–7.3.4，表 7.1，图 7.3–7.5；`SWS_EcuM_02411`、`02603`、`02934`、`02798` | C 环境前提；InitZero/PB 配置/InitOne；OS 控制权交接；post-OS 的 SchM/BswM 顺序；配置一致性检查 |
| [Mode Management Guide][mode-guide] | R24-11；§3.3.3–3.3.4，印刷页 33–35 | BswM 初始化规则、NvM 完成后推进启动的示例、RTE 生命周期和应用模式门控 |
| [RTE Software SWS][rte] | R24-11；§5.8.2–5.8.4；`SWS_Rte_06749`、`06751`、`SWS_Rte_CONSTR_09060`、`SWS_Rte_91143` | `Rte_Start`、生成的 `Rte_Init_<InitContainer>`、`Rte_StartTiming` 的不同职责和依赖 |
| [NVRAM Manager SWS][nvm] | R24-11；§8.3.3.1；`SWS_NvM_00460`、`00243`、`00667`、`00394`、`00179`、`00347` | `NvM_ReadAll` 是异步多块请求；pending 与完成不同；块号 0 查询整体请求结果；周期处理与完成通知 |
| [Communication Manager SWS][comm] | R24-11；`SWS_ComM_00884`、`00885`、`00092`；§9.1 | 初始化后的 CommunicationAllowed 默认关闭；请求模式与实际模式可暂时不同；总线状态指示 |
| [CAN State Manager SWS][cansm] | R24-11；§7.2.22、§8.3.3、§8.6.1.1；`SWS_CanSM_00062`、`00485`、`00489`、`00493` | `CanSM_RequestComMode` 的 E_OK 仅为接收请求；收发器/控制器模式确认；CanIf PDU 模式 |
| [Basic Software Mode Manager SWS][bswm] | R24-11；配置项 `BswMComMAllowCom`、`ECUC_BswM_00918`、`00912` | BswM 可通过配置动作调用 `ComM_CommunicationAllowed` |
| [MCU Driver SWS][mcu] | R24-11；§8.3.3–8.3.5；`SWS_Mcu_00138`、`00139`、`00142` | 初始化 MCU 后才初始化时钟；初始化时钟的返回不代表 PLL 已锁定；切换 PLL 时钟前检查锁定状态 |
| [DIO Driver SWS][dio] | R24-11；§7.2；`SWS_Dio_00001` | DIO 不提供硬件初始化接口，硬件初始化由 Port Driver 执行 |
| [Memory Abstraction Interface SWS][memif] | R24-11；§8.3.1–8.3.8 | MemIf 提供访问、状态查询等接口，没有标准 `MemIf_Init` API |
| [Diagnostic Event Manager SWS][dem] | R24-11；§7.11.5，印刷页 236–237；§8.3.3.29 | Dem 可配置成 RAM-only；使用持久块前须检查其有效性与完整性；事件报告 API `Dem_SetEventStatus` |
| [Diagnostic Communication Manager SWS][dcm] | R24-11；诊断会话、安全级别、服务处理；§7.4.2.19–7.4.2.22 的 `0x34/0x36/0x37` | DCM 位于诊断协议处理边界；TransferData 依赖先前的 RequestDownload/Upload；服务与刷写条件取决于项目配置 |
| [CAN Transport Layer SWS][cantp] | R24-11；CAN N-SDU 传输、分段、流控与重组 | 经典 CAN 上诊断长消息的 SF/FF/FC/CF 分帧概念；本实验只呈现确定性的正常交换 |
| [Watchdog Driver SWS][wdg] | R24-11；§8.3.1–8.3.4、§9.1 | 标准对外 API 包括 `Wdg_SetTriggerCondition`，不能将旧 `Wdg_Trigger` 当成本基线的接口 |
| [CDD Design and Integration Guideline][cdd-guide] | R24-11；§6.2–6.3 | CDD 的关键资源保护、EcuM/BswM 模式管理、Det/Dem 错误上报与建议文件结构 |
| [Operating System SWS][os] | R24-11；§7.9 多核 OS；IOC、Spinlock、OS-Application | 多核 OS 的每核运行数据、跨 OS-Application 通信和共享资源保护概念 |
| [BSW Distribution Guide][bsw-distribution] | R24-11；§2.3 | 跨分区 BSW 的 SchM 调用/数据代理及通过 IOC 实现的示例 |
| [ECU State Manager Fixed SWS][fixed] | **历史版本 R4.3.1（2017 年）**；§7.3.3–7.3.5，图 5–6；§8.7.2.5 | 仅用于解释旧 Fixed 的 STARTUP I/II、DriverInitTwo/Three 以及与现代 Flexible 的差异 |

## 必须保留的版本说明

- EcuM R24-11 的变更历史注明 4.4.0 已移除 Fixed 版本引用。R4.3.1 Fixed 文档是多年以前的历史资料，不能据此宣称现代 Flexible 必须具有同样的状态机或调用列表。[EcuM SWS][ecum]
- 旧 Fixed 的图 6 先启动 RTE、向 SW-C 提供 STARTUP 模式，再处理 NvM 等待与 InitThree/RUN 推进；因此“任何 AUTOSAR 都必须先完成 NvM_ReadAll 才能调用 Rte_Start”不是普遍规则。[Fixed SWS][fixed]
- 本项目采用“依赖的 NvM 数据就绪后再放行业务”的保守教学策略。具体模块是否需要等待 NvM、是否允许缺省数据、是否有降级运行，属于项目配置和错误处理策略。[Mode Management Guide][mode-guide]
- 指南里的初始化清单是示例伪代码，含简写和历史模块名称。真实工程必须以选定版本的模块 SWS、BSW 模块描述和生成的头文件为准，不应原样复制整张示例表。[Mode Management Guide][mode-guide]
- `NvM_JobEndNotification` 是底层存储抽象向 NvM 报告单次底层作业完成的回调，不是 NvM 向 BswM 报告整个 ReadAll 完成的接口。后者可使用配置的 `BswM_NvM_CurrentJobMode`；R24-11 的首参是 `NvM_MultiBlockRequestType`，不是旧版的原始 ServiceId。[NvM §8.3.3.6.1、图 9.11][nvm]；[BswM §8.3.25][bswm]

## 本项目没有模拟的内容

没有 CPU 指令执行、真实 MCU 寄存器、真实 AUTOSAR OS、商业 RTE/BSW/MCAL、真实 CAN 线电平及总线仲裁、硬件启动时延或安全机制认证。UDS 实验台不实现真实 P2/P2*/S3 计时、DoIP、Flash 驱动、签名信任链、防回滚、量产密钥或 DCM 配置生成；“刷写”只改变浏览器内存中的教学分区。画面中的延迟、任务、内存、报文、DID、DTC、Seed/Key、固件和状态值都是教学模型；教学的 7 阶段 / 42 步不是 AUTOSAR 规定的固定数量。

项目的严格依赖检查用于帮助学习，不应替代真实 ECU 的集成验证。查看[学习指南](learning-guide.md)了解如何区分规范约束与本示例的策略。

[current]: https://www.autosar.org/news-events/detail/release-r25-11-is-now-available
[ecum]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_ECUStateManager.pdf
[mode-guide]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_ModeManagementGuide.pdf
[rte]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_RTE.pdf
[nvm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_NVRAMManager.pdf
[comm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_COMManager.pdf
[cansm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_CANStateManager.pdf
[bswm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_BSWModeManager.pdf
[mcu]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_MCUDriver.pdf
[dio]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DIODriver.pdf
[memif]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_MemoryAbstractionInterface.pdf
[dem]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DiagnosticEventManager.pdf
[dcm]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DiagnosticCommunicationManager.pdf
[cantp]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_CANTransportLayer.pdf
[wdg]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_WatchdogDriver.pdf
[cdd-guide]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_CDDDesignAndIntegrationGuideline.pdf
[os]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_OS.pdf
[bsw-distribution]: https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_EXP_BSWDistributionGuide.pdf
[fixed]: https://www.autosar.org/fileadmin/standards/R4.3.1/CP/AUTOSAR_SWS_ECUStateManagerFixed.pdf
