# 字幕打轴工作台（Subtitle Timing Editor）

本地运行的网页版字幕打轴编辑器：视频/音频播放、Aegisub 式音频盒（波形/时间标尺/标记拖拽/提交模型）、字幕列表行内编辑、SRT/VTT/ASS 读写、ASS 样式预览；另带一套零依赖的 Agent 工具链（headless CLI + 浏览器 harness），可与任意 ASR 流水线配合完成自动粗打轴。

**零构建、零 npm 依赖、纯本地运行**——不联网、不上传任何文件。

![字幕打轴工作台：播放器、字幕列表与 Aegisub 式音频盒](resources/preview1.png)

## 启动

两种方式：

**方式一：单文件版（双击即用）**

从 [GitHub Releases](https://github.com/yuukimasato/subtitle-editor/releases) 下载最新的 `subtitle-editor-standalone-*.html`，或直接用浏览器打开本仓库的 `subtitle-editor-standalone.html`——全部代码与 JASSUB 的 wasm/worker/字体内嵌在一个文件里，无需任何服务（worker/wasm/字体注入为 `data:` URL，`file://` 下 ASS 样式预览同样可用）。

重新生成单文件版：`node build-standalone.mjs`（需 npx 拉取 esbuild，仅构建期使用）。

**方式二：模块版（开发形态）**

ES Modules 需要 HTTP 服务（`file://` 直接打开 `index.html` 会被浏览器安全策略拦截）：

```bash
cd tools/subtitle-editor
python3 -m http.server 8631
# 打开 http://127.0.0.1:8631/
```

或使用任意静态服务器（`npx serve`、nginx 等）指向本目录。

## 音频盒（对齐 Aegisub 3.2 交互）

音频盒由三部分组成：顶部时间标尺（拖动平移视图）、中部波形显示（选区与标记）、下方工具栏（播放/定时/提交命令与开关），右侧为横向缩放、纵向振幅、音量三个滑条与联动开关。选项默认值与 Aegisub 相同：自动提交关、提交后自动转至下一行开、自动滚动开、吸附关、非活动行显示上一行。

### 鼠标（对活动行生效，波形/降级刻度视图均可用）

| 操作 | 行为 |
|---|---|
| 左键单击 | **设定开始时间**（红线移到点击处）；若越过原结束点，结束点并拢到点击处等待重设 |
| 右键单击 | **设定结束时间**（蓝线移到点击处）；若越过原开始点，开始点并拢到点击处 |
| 左键按住拖动 | 以按下位置为开始扫选区间，抬起定结束；向左拖越过起点则起点跟随 |
| 左键之后按住右键拖动 | **经典双键打轴**：以左键起点为锚，移动调整区间，右键抬起的位置就是结束时间 |
| 左键拖标记边缘（3px 内，光标 ↔） | 微调开始 / 结束 |
| Alt+拖 | 整段平移（多选行一起移动） |
| Ctrl+拖标记 | 同时拖动各行共位的边界（含非活动行） |
| Shift+拖 | 临时吸附到其他行边界（10px；工具栏「吸附行边界」开启时按 Shift 反之为不吸附） |
| 中键 | 把播放头定位到该处 |
| 滚轮 / Ctrl+滚轮 | 滚动视图 / 缩放波形 |
| 释放在显示边缘 1/20 内 | 视图自动滚过 1/3（自动滚动开启时） |

拖拽只改「预览」：波形上立即可见、可试听，但**不写入字幕行**；按 `G`/「✓ 提交」才落库（一步撤销），「自动下一行」开启时提交后前进到下一行。切换行会丢弃未提交的改动。开启「自动提交」后拖拽即时写入，连续改动合并为一步撤销。

### 键位

音频盒获得焦点（点击波形区）后进入 Aegisub「Audio」键位上下文；小键盘键位在文本/时间输入框以外的任何焦点下可用（`e.code` 识别，NumLock 任意状态；输入框内需保留数字录入，故禁用）。

| 键 | 动作 |
|---|---|
| `S` / `Space` | 播放选区（生效时间，含未提交改动） |
| `R` | 播放当前行 |
| `B` | 播放选区 / 停止 切换 |
| `H` | 停止 |
| `Q` / `W` | 试听选区开始前 / 结束后 500ms |
| `E` / `D` | 试听选区前 500ms / 后 500ms 段 |
| `T` | 从选区开始播放到结尾 |
| `←/→` 或 `Z`/`X` | 上一行 / 下一行 |
| `G` / `Enter` | 提交（自动下一行开启时前进） |
| `Shift+G` | 提交并新建一行（默认时长 2s） |
| `C` / `V` | 前置（开始 −200ms）/ 延后（结束 +300ms） |
| `A` / `F` | 视图左移 / 右移 |
| 小键盘 5 / 8 | 播放选区 / 停止 |
| 小键盘 1 / 3 | 试听开始点前 / 结束点后 500ms |
| 小键盘 Enter | 提交 |
| 小键盘 `+` / `−` | 加长 / 缩短 10ms |
| 小键盘 4/6 / 7/9 | 开始点前移/后移、缩短/加长（±10ms，与 Aegisub 一致） |
| 小键盘 2 / 0 | 下一句 / 上一句（只切换，不动播放头） |

其余全局键位：`Space` 播放暂停（音频盒外）；`←/→` 快退快进（音频盒外，随缩放自适应）；`,`/`.` 逐帧；`N` 插入；`Delete` 删除选中行；`Ctrl+D` / `Ctrl+M` 拆分 / 合并；`Ctrl+X/C/V` 剪切 / 复制 / 粘贴；`Ctrl+A` 全选；`L` 循环当前句；`F` 列表跟随滚动（音频盒外）；`Ctrl+Z` / `Ctrl+Shift+Z` 撤销重做（在输入框内为浏览器原生文本撤销）；`Ctrl+S` 按当前格式导出。完整列表见页面内「快捷键」。

## 使用

1. 点击「打开媒体」或把 视频/音频 文件拖进页面；
2. 点击「打开字幕」或拖入 SRT/VTT/ASS 字幕（也可以从零开始：把播放头移到目标位置按 `N` 或点「插入」）；
3. 按上面的音频盒方式打轴：点击列表行选中，波形上扫选/拖标记定时，`S` 试听、`G` 提交；
4. 字幕列表位于播放器右侧：**单击选中行，双击文本 / 时间进入编辑**（文本停顿约 0.7s 自动提交；时间字段在失焦或回车时提交，避免半输入被误写；Esc 退出编辑），**修改后自动保存草稿**（localStorage）；播放时当前句自动高亮滚动；
5. **右键字幕行**打开行操作菜单：插入（之前/之后）、以视频时间插入（之前/之后）、重复行、剪切行、复制行、粘贴行、选择性粘贴、删除行；Ctrl 点击加选 / Shift 点击连选，多选行会随活动行一起定时（Aegisub 同款）；
6. **智能粘贴**：剪贴板为纯多行文本（如逐行歌词、译文）时，「粘贴行 / 选择性粘贴」自动**按行新建字幕行**——从参考行结束处（无参考行则播放头/文档开头）起每行顺序占位 5 秒，之后在音频盒逐句打轴；剪贴板为 SRT / VTT / ASS 内容（含从 Aegisub 复制的 `Dialogue:` 行）时按原时间解析粘贴，「选择性粘贴」弹出字段覆盖对话框（Aegisub Paste-Over 语义）；
7. 「导出 SRT / VTT / ASS」下载结果；下次打开同名字幕时可恢复本地草稿。

**面板大小可调**：播放器在左、字幕列表在右、音频盒横贯底部；拖动字幕列表左缘的竖条调整列表宽度，拖动音频盒上方的横条调整音频盒高度，双击分隔条复位，布局自动记忆。

## 字幕格式

- **SRT / WebVTT**：双向读写；VTT 的 cue settings、`STYLE` / `REGION` 块、头部元数据与 cue 标识行原样保留。
- **ASS/SSA**：基础读写——文本与时间可编辑，`{\...}` 标签原样保留，其余字段（样式、边距等）与文档其余部分逐字保留；删除的句子对应行整体移除，新建句子以默认字段追加。从 SRT/VTT 导出 ASS 时自动构造最小合法骨架。
- **列表显示约定**：字幕列表只放纯正文——行首的 `{\...}` 覆盖标签段与 `[标签]` 说话人前缀仅在显示层拆掉，数据始终完整；双击进入编辑可见原始正文（可增删标签），提交时未改动的标签/说话人自动拼回。说话人列默认隐藏，勾选字幕工具条上的「说话人」显示；文本预览 overlay 同样不显示标签与说话人。ASS 标签的特效渲染见「ASS 样式预览」。
- **ASS 样式预览**：经 JASSUB（WASM libass）按样式渲染到画面，可开关；编辑内容约 0.6s 后经 `setTrack` 原地换轨刷新（不重建 worker），视频暂停时也会主动补帧，改完即见。**纯音频媒体没有视频画面**（libass 按视频尺寸出图），预览自动关闭并回退为文本 overlay，字幕照常显示。默认字体为内置的 **Noto Sans CJK SC 子集**（CJK 基本区全部汉字，简繁通用 + 拉丁 + 假名，见 `vendor/noto-sans-sc-LICENSE`）：libass 只在样式字体缺少字形时回退到默认字体，因此样式里写 `Arial` 之类无汉字字形的字体时，中文仍能正常显示；样式字体在本机可用时优先按样式字体渲染——Chrome/Edge 下首次启用预览会弹出一次「读取本地字体」授权（Local Font Access API），授权后 libass 按样式里写的字体名从本机加载，与 Aegisub 一致；Firefox/Safari 没有该 API，只能用内置字体。样式预览初始化失败时自动回退为纯文本预览，不影响编辑。

## 本地管线集成（可选）

工具本身完全离线可用；检测到本机 `http://127.0.0.1:8613` 的字幕管线服务时，顶栏额外提供两个入口（地址可改，探测失败自动隐藏）：

- **管线**：提交音视频任务 → 跟踪进度 → 载入字幕产物（含 review-manifest 逐行出处标注）与原声，精修后导出。
- **学习**：把当前会话的音频 + 校对完成的字幕一键回传学习（先「预览差异」dry-run 再「确认学习」，编辑日志顺带上送、幂等去重）；也可手动选择音频与修正字幕学习旧素材。

## 开发

```bash
node --test        # 解析器、动作、定时控制器、采集与剪贴板/格式单测（126 项）
```

目录结构：`js/audio/timing.js` 为 Aegisub 对话定时控制器（audio_timing_dialogue.cpp）的语义移植（纯逻辑，可单测）；`js/audio/capture.js` 为波形兜底解码（加速采集，采集数学部分可单测）；`js/audio/commands.js` 为音频命令层；`js/ui/waveform.js` 为音频显示（指针/滚轮/标尺/覆盖层）；`js/ui/audio-toolbar.js` 为工具栏与滑条。浏览器控制台可用 `__editor` 句柄查看内部状态；`?media=<url>&subs=<url>` 可在启动时自动加载（测试/演示用）。

## 与 ASR 流水线集成

本工具是**独立开源组件**，定位于 ASR 的功能补充：ASR 引擎产出文本与粗时间 → 本工具做时间轴精修（打轴）。任何流水线（包括但不限于 [Vocal_Subtitle](https://github.com/yuukimasato/Vocal_Subtitle)）都可以作为消费者接入，方式有三层：

1. **Headless CLI（`agent/cli.mjs`，零依赖）**——字幕读写变换、格式互转、结构校验、波形峰值、语音段候选（内置确定性 VAD，可选外部 provider 增强），全部 JSON in/out 与稳定退出码（0 正常 / 2 输入错误 / 3 校验发现问题），可直接被脚本或 Agent 驱动：

   ```bash
   node agent/cli.mjs vad media.mkv > seg.json              # 语音段候选（内置，零依赖）
   node agent/cli.mjs cues draft.srt set --plan plan.json -o timed.srt
   node agent/cli.mjs check timed.srt --media media.mkv     # 退出码 0 才放行
   ```

2. **页面 Agent API（`window.agent`，版本化契约）**——在真实页面中读状态/波形、执行编辑命令，配合撤销栈与草稿机制人机同屏（agent 会话 `?agent=1` 使用独立草稿命名空间）；
3. **通用 CDP harness（`agent/harness.mjs`，零依赖）**——经 Chrome DevTools Protocol 驱动真实页面（`open/eval/shot/close` 原语，不绑定本产品）；
4. **MCP server（`agent/mcp-server.mjs`，可选）**——把上述 CLI/harness 命令挂成 MCP tools，供 ZCode 等 Agent 客户端即插即用。

能力分层：Tier 0（字幕变换/校验）与 Tier 1（WAV 直读）仅靠 Node 标准库即可用；ffmpeg 检测到即用（任意媒体解码）；内置 VAD 零依赖默认可用；更高质量的 VAD 通过 `docs/vad-provider-contract.md` 定义的可选 provider 契约接入，缺失时自动退回内置实现。环境理解入口见 **[AGENTS.md](AGENTS.md)**，设计依据见 `docs/`。

## 已知限制

- ASS 样式预览的内置 CJK 字体覆盖 CJK 基本区（含简体与繁体）；基本区之外的生僻字（CJK 扩展 A/B 区等）仍显示为空白/豆腐块，此时可安装对应字体并授权本页读取本地字体，或改用纯文本预览；
- 波形优先走浏览器 `decodeAudioData`；覆盖不了的媒体（MKV/WebM 容器、AC-3/DTS 等音轨、单文件版 `file://` 下的 fetch 限制、超大文件）自动改用「加速采集」兜底：后台以倍速静默快进一遍媒体并边采边降采样（4kHz 单声道，约 57MB/小时），完成后显示波形，进度可取消；无音轨或采集失败时降级为时间刻度视图：上述鼠标定时与播放命令同样可用，仅无波形细节、滚轮缩放与视图滚动；
- 仅支持浏览器原生可播放的媒体格式；卡拉OK音节定时与频谱视图未实现（工具栏不含对应开关）。

## 版权与实现声明

- 本项目代码以 **MIT 许可证**发布，详见 **[LICENSE](LICENSE)**。
- 本工具为**独立实现**：交互模型对齐 Aegisub 3.2 的公开文档行为（Aegisub 为 BSD-3-Clause 开源软件），代码为从零编写，未复制、未分发 Aegisub 的任何源代码或美术资源。
- 第三方组件均在 `vendor/` 内以原始产物形式分发并保留许可声明，详见 **[vendor/NOTICE.md](vendor/NOTICE.md)**：
  - ArtPlayer 5.4.0 —— MIT License © Harvey Zhao（zhw2590582）
  - wavesurfer.js 7.12.11 —— BSD 3-Clause © katspaugh and contributors
  - JASSUB 2.5.14 —— JS 为 MIT；其 WASM 产物内含 libass/freetype/fribidi/harfbuzz 等编译库（LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0，均为商用友好许可）
  - Noto Sans CJK SC 子集（`vendor/noto-sans-sc-subset.woff2`）—— SIL OFL 1.1 © 2014-2021 Adobe，供 ASS 样式预览的中文回退字体使用
- `vendor/jassub.esm.js` 为上游 `dist/jassub.js` 与其运行时依赖的 esbuild 打包产物，未修改任何逻辑。
