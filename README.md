# 提炼 · B 站视频 / 音频 / 封面提取

[![CI](https://github.com/ailciat/bili-extractor/actions/workflows/ci.yml/badge.svg)](https://github.com/ailciat/bili-extractor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-1976d2.svg)](LICENSE)

本地运行的工具：粘贴 B 站链接，选好画质，把视频 / 音频 / 封面保存到本机。支持批量处理与扫码登录。文件只落在自己的硬盘上。

- 项目地址：<https://github.com/ailciat/bili-extractor>
- 在线演示：<https://modelscope.cn/studios/awazas/bili-extractor>（仅解析与复制原链接，不提供下载）

---

## 快速开始

**桌面应用（推荐）**：从 [Releases](https://github.com/ailciat/bili-extractor/releases) 下载 `bili-extractor-<版本>-win-x64.zip`，解压后双击其中的 `哔哩提取器-<版本>-win-x64.exe`。免安装，无需 Node。首次运行若提示 SmartScreen，选「更多信息 → 仍要运行」。

**便携包**：下载 Releases 中的 `bili-extractor-v<版本>-win32-x64.zip`，解压后双击 `启动.bat`（macOS / Linux 用 `./start.sh`）。依赖已内置，无需 `npm install`。

**源码运行**：需 Node.js 18 以上。

```bash
git clone https://github.com/ailciat/bili-extractor.git
cd bili-extractor
npm install
npm start
```

依赖只有两项：`qrcode`（扫码登录）与 `@ffmpeg-installer/ffmpeg`（高清音视频合并）；缺失时对应功能降级，不影响基本使用。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 三种提取 | 视频 MP4 / 音频 M4A / 封面原图 JPG，顶部分段切换 |
| 批量处理 | 每行一条，最多 30 条，自动去重后勾选下载 |
| 分集多选 | 多 P 视频列出全部分集，可勾选任意几集，显示已选数量与合计时长 |
| 扫码登录 | B 站 App 扫码，解锁 1080P / 1080P60 / 4K |
| 链接识别 | BV 号、av 号、完整链接、`b23.tv` 短链、番剧 `ep` / `ss` |
| 画质探测 | 只列出真实可下载的档位，不显示下不动的选项 |
| 音频音质 | 访客可选 64K / 132K / 192K；杜比与 Hi-Res 需大会员 |
| 其他 | 并发限流（最多 3）、失败自动重试、最近记录、记住画质、文件夹选择保存位置 |
| 任务管理 | 排队 / 下载 / 合并中的任务可随时取消，失败可一键重试 |

支持的链接：

```
https://www.bilibili.com/video/BV1GJ411x7h7
https://www.bilibili.com/video/av80433022
BV1GJ411x7h7
https://b23.tv/xxxxxxx
https://www.bilibili.com/bangumi/play/ep123456
```

---

## 登录与画质

未登录为访客，最高 720P（B 站服务端限制）；登录后可用 1080P / 1080P60 / 4K。

1. 点右上角「游客」
2. 用 B 站 App 扫码并确认登录
3. 清晰度列表自动刷新出更高档位

≤720P 是音视频已合并的单文件；>720P 是 B 站提供的 DASH 分离流，由内置 ffmpeg 无损封装成一个 MP4，无需另行配置。

登录凭证只保存在本机 `config.json`（AES-256-GCM 加密，密钥绑定当前用户与主机），不上传、不发给第三方。无法扫码时可在设置里手动填写 `SESSDATA`。

---

## 文件与命名

- 源码 / 便携包版：程序目录下的 `downloads/`
- exe 版：`C:\Users\<用户名>\.bili-extractor\downloads\`

可在设置里修改，侧栏队列底部的「打开文件夹」直达。命名规则：

```
视频标题 [清晰度].mp4
视频标题 - P2 分集名 [清晰度].mp4
视频标题 [192K 高品质].m4a
视频标题 - 封面.jpg
```

清晰度标注为**实际下载到的档位**，不是请求的档位。重名自动加 `(1)`、`(2)`，并发下载不会互相覆盖。

---

## 安全

服务只监听 `127.0.0.1`，局域网内其他设备无法访问。另有 Host / Origin / Sec-Fetch-Site 校验（防 DNS 重绑定与跨站请求伪造）、请求限流、严格 CSP、响应安全头、封面代理白名单与逐跳重定向校验、路径穿越防护、外部命令参数数组化。`config.json` 每次启动自动收紧文件权限。

这些属于**本机防护**：可挡恶意网页借用浏览器调用本地接口、误传配置文件等情形。若系统本身已被控制（远程桌面、木马），需要系统级密钥管理。

---

## 常见问题

**提示「触发风控」或下载变慢**：B 站对高频请求有限制。隔几分钟再试，登录后明显改善；批量并发已限制为 3。

**某些视频解析失败**：付费课程、充电专属、地区限制内容无法获取。已删除的视频会提示「视频不存在」。

**下载中断**：重新下载即可，`.part` 临时文件会自动清理。

**批量多 P 视频会下全部集吗**：不会，默认只下第 1 集，列表会标注「NP · 默认第 1 集」；其他集请单独解析。

**音频能转 MP3 吗**：不支持。M4A 是 AAC 容器，体积更小、音质更好，主流播放器都支持。

---

## 项目结构

```
bili-extractor/
├── 启动.bat              # 双击运行
├── server.js             # 本地服务：接口代理 / 扫码登录 / 下载引擎
├── public/
│   ├── index.html
│   ├── app.js            # 前端逻辑
│   ├── theme-init.js     # 主题预置（独立文件，便于启用严格 CSP）
│   ├── sea-bubbles.js    # 背景水泡动效
│   └── styles/           # 设计令牌 / 基础样式 / 组件样式
├── start.sh              # macOS / Linux 启动脚本
├── electron/main.js      # 桌面窗口壳
├── build/icon.ico        # 应用图标（exe 与窗口共用，6 尺寸）
├── scripts/
│   ├── ci-check.js       # 静态自检
│   ├── ensure-deps.js    # 依赖自检 / 首次自动安装
│   ├── pack.js           # 打轻量便携包
│   └── make-zip.js       # 把中文名 exe 打成英文名 zip（发布用）
├── .github/workflows/    # ci.yml 自检；build-exe.yml 手动打包并发布
├── downloads/            # 下载的文件
├── dist/                 # 打包产物（均不入库）
└── config.json           # 登录凭证与设置（首次保存时生成，勿外传，已加入 .gitignore）
```

---

## 开发与构建

```bash
npm run check    # 静态自检：JS 语法、DOM id 引用、CSS 变量、内联脚本
npm test         # 接口级测试：起隔离实例（临时数据目录），覆盖安全/任务/演示模式
npm run app      # Electron 独立窗口
npm run app:pack # 打中文名 exe（需 Windows）
npm run app:zip  # 套一层英文名 zip
npm run pack     # 打轻量便携包
```

Windows 构建有两条入口，互不干扰：

| 场景 | 触发方式 | 结果 |
| --- | --- | --- |
| 日常测试 | Actions 里手动运行 **Build exe** | 构建 + 校验 + 上传 Artifact（不碰 Release） |
| 正式发布 | 推送 `v*` 版本 Tag | 构建 + 校验 + 自动创建 Release 并附带 `SHA256SUMS.txt` |

发布步骤：改版本号 → 提交推送 → 打 Tag 推送。

```bash
npm version 2.1.0 --no-git-tag-version   # 同步 package.json 与 lock
git add package.json package-lock.json && git commit -m "chore: release v2.1.0"
git push origin main
git tag -a v2.1.0 -m "哔哩提取器 v2.1.0" && git push origin v2.1.0
```

Tag 必须与 `package.json` 版本一致，工作流会校验，不一致直接失败。发布包用英文名 zip、内部保留中文 exe，是因为 GitHub 上传资源时会吞掉文件名里的中文前缀。

---

## 免责声明

使用本工具即表示你已阅读并同意以下条款：

1. **用途限制**：仅供个人学习与技术研究。不得用于商业用途、批量牟利，或任何违反法律法规的活动。
2. **版权归属**：所下载的视频、音频、封面等内容，著作权归原作者及哔哩哔哩平台所有。本工具不托管、不分发任何第三方内容。
3. **使用规范**：请在下载后 24 小时内自行删除；不得二次传播、公开分发或用于任何侵权目的。
4. **账号风险**：扫码登录与高频请求可能触发平台风控，导致账号受限或功能异常，相关风险由使用者自行承担。
5. **无担保**：软件按「原样」提供，不保证在任何环境下均可用，不对数据丢失、设备损坏或下载失败等后果负责。
6. **无关联**：本项目为独立开发，与哔哩哔哩官方无任何关联、授权或背书。
7. **法律合规**：使用者须遵守《中华人民共和国著作权法》及 [B 站用户协议](https://www.bilibili.com/blackboard/protocol.html)。因使用本工具产生的一切争议、损失与法律责任，由使用者自行承担。

---

## 许可证

[MIT](LICENSE) © 2026 ailciat
