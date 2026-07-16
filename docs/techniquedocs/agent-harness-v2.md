Agent harness

## 定义与要求
这里默认定义的是 work agent，工作在用户的本地电脑上，已指定文件夹为工作区。这里设计 agent 为一个常驻的 bun 进程。


## 作为系统服务安装
支持 linux/macos/windows 等三个平台
cli.ts 暴露一组服务命令
loopIQ install/ uninstall / start / stop / restart / status / logs / doctor.....

平台分派 (service/index.ts):
  ┌── linux.js   → systemd unit    loopIQ[@<id>].service
  ├── macos.js   → launchd plist   com.loopIQ[.<id>]
  └── windows.js → pm2 app         loopIQ[-<id>]  (+ 隐藏托盘)
install 做三件事(service/index.ts):

initDir — 建 ~/.yeaft + 默认 config.json
tryAutoConfigureGitHubCopilot — 有 Copilot 就自动配好 provider(开箱即用)
生成并注册平台服务单元(systemd/launchd/pm2)→ 开机自启 + 崩溃重启

## agent engine
一个 agent engine 是运行在真实单例



## booststrap



## 本地数据
每个实例拥有独立的
数据目录，

日志目录，

配置目录


