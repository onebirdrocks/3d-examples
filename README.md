# Lumen Atlas · 光影图谱

一个可浏览 **3D 实时效果**的画廊：同一套代码支持普通浏览器与 WebXR 沉浸浏览。Apple Vision Pro 的 Safari 使用 `immersive-vr`；真实空间放置另需浏览器与设备支持 `immersive-ar` 和命中测试，不能把 VR 支持视为 AR 支持。

48 个场景，分六类；场景的视觉**跟随正在播放的音乐变化**；冥想与助眠场景带呼吸引导；戴上头显后场景会真实地环绕在你身边，可以用手直接触碰。

---

## 快速开始

```bash
npm install
npm run dev       # 开发服务器 http://localhost:5173
npm run build     # 类型检查 + 生产构建 → dist/
npm run preview   # 预览构建产物 http://localhost:4173
npm run verify    # 回归检查：逐个打开 48 个场景，查报错 / 黑屏
npm run verify:viewer # 场景页按钮、布局、键盘、音频和模拟 XR 交互检查
npm run verify:experience # 首页导航、收藏、定时与生命周期检查
npm run thumbnails:build # 场景视觉变化后，重新生成48张静态WebP预览
npm run thumbnails:check # 检查静态预览完整性
```

`npm run verify` 需要本机装有 Chrome 或 Chromium（不额外下载浏览器）。它会逐个打开全部场景，检查控制台报错、错误面板与画面是否全黑 —— GitHub Actions 上每次 push 都会自动跑一遍。

`npm run verify:viewer` 同样复用已有浏览器，临时启动独立端口的本地服务器，并在结束后关闭。它使用短音频夹具验证真实解码与暂停恢复，使用模拟 XR 接口检查放置状态、失败回退和延迟加载清理；不代表头显、真实房间追踪或空间音频听感已通过验证。设置 `VIEWER_SCREENSHOTS=/absolute/path` 可保存布局截图。

首页使用 `public/thumbnails/` 的静态 WebP 图片并按需加载，不在访问时运行全部场景或加载空间音效。修改场景构图后运行 `npm run thumbnails:build`，并一起提交生成的预览；普通构建不要求安装或下载新浏览器。XR 场景墙复用这些图片。

`npm run verify:experience` 覆盖搜索、收藏、最近使用、分类内切换和返回位置、授权失败恢复、无效链接、画质与减少动态偏好、控制栏隐藏、定时结束以及空间音源取消。定时检查使用模拟时间；可通过 `EXPERIENCE_SCREENSHOTS=/absolute/path` 保存界面截图。

### 浏览与静心

- 首页可搜索名称、说明和标签，按分类浏览或查看收藏、最近24个使用过的场景；从场景页返回时恢复筛选与滚动位置，上下切换沿用当前浏览范围。
- 场景页的“体验设置”提供省电 / 均衡 / 清晰画质、暂停画面、减少动态、后台声音选择以及5 / 10 / 20 / 30 / 60分钟定时。画质调整会重新加载当前场景，XR会话期间不可调整。
- 定时以实际截止时间为准，最后10秒同时降低配乐和空间音源音量，结束后静音、暂停画面并显示继续入口。浏览器或系统挂起时无法保证按秒执行，恢复页面时会立即对齐截止状态。
- 隐藏控制栏后，可轻点画面、使用显示按钮或按Esc恢复。减少动态默认遵循系统偏好，显式选择后保存到本机。
- 收藏、最近使用、音量、静音和体验偏好仅保存在当前浏览器。存储被禁用时退回当前页面内存，不影响正常浏览。

回归检查在 CI 上按 **6 个分片并行**跑（`VERIFY_SHARD` / `VERIFY_SHARDS`）：每个 runner 只跑其中 8 个场景，查逻辑一字不改，整轮约 2 分钟。

渲染档位默认与作者看到的完全一致（视口 640×400、画质 1），需要时可用 `VERIFY_WIDTH` / `VERIFY_HEIGHT` / `VERIFY_QUALITY` 临时调低。

| 页面 | 用途 |
| --- | --- |
| `/` | 画廊首页：静态预览、搜索、分类、收藏、最近使用与沉浸模式入口 |
| `/scene.html?id=<id>` | 场景查看器：呼吸引导、混音、画质、定时、控制栏与沉浸 / AR 放置 |
| `/lab.html?scene=<id>` | 场景实验室：单独调试某个场景 |
| `/webgpu.html` | WebGPU / TSL 实验场（独立管线，不在画廊内） |

---

## 场景清单（48）

### 程序化效果（12）
`volumetric` 体积光 · `galaxy` 星河漩涡 · `fluid` 流光水面 · `tunnel` 无限隧道 · `aurora` 极光夜空 · `terrain` 云海群山 · `stainedglass` 琉璃彩窗 · `fireflies` 萤火微光 · `gpu-tide` GPU 粒子潮汐 · `metaball` 熔核等值面 · `neon-pipeline` 霓虹雨夜 · `crystal-cave` SDF 晶体洞穴

### 模型 · 材质（6）
`material-lab` 材质实验室 · `city` 城市微缩 · `robot` 机械守卫 · `helmet` 头盔工坊 · `celadon` 青瓷茶器 · `terrarium` 苔藓生态瓶

### 冥想（7）
`breathing` 呼吸之光 · `raindow` 雨夜窗 · `zenstones` 禅石 · `candle` 烛火 · `tides` 夜潮 · `mandala` 万象 · `breathing-universe` 呼吸宇宙

### 助眠（10）
`void-drift` 虚空漂流 · `snowfall` 落雪夜 · `ember-hearth` 壁炉余烬 · `fog-lighthouse` 雾中灯塔 · `bamboo-wind` 竹林夜风 · `tide-cave` 洞穴潮汐 · `deep-void` 深海之眼 · `moon-well` 月井 · `paper-lanterns` 孔明灯 · `sand-fall` 沙漏

### 真实环境（11）
`rainy-street` 雨夜街道 · `forest-stream` 林间溪流 · `sea-cliff` 海崖听涛 · `snowfield` 旷野风声 · `desert-night` 沙漠星夜 · `tea-room` 和风茶室 · `planetarium` 星象仪 · `misty-pines` 雾松林 · `harbor-dusk` 港湾黄昏 · `rice-terrace` 梯田晨光 · `moonlight-garden` 月夜庭院

### 模拟（2）
`silk-drape` 悬垂绸缎 · `piano-ruins` 废墟里的钢琴

---

## 三条核心机制

### 1. 音乐驱动画面

`ctx.audio` 把正在播放的音乐转成可驱动画面的数值：

| 量 | 含义 | 典型用法 |
| --- | --- | --- |
| `pulse` | 主脉冲，低频起音触发（快起慢落） | 光的涨落、雨势、水位、火焰高度 |
| `level` | 整体响度 | 亮度、雾浓度、辉光强度 |
| `bass` / `mid` / `treble` | 三个频段能量 | 分层驱动细节（低频震颤 / 湍流 / 闪烁） |

没有音乐时，`pulse` 自动回落到场景声明的 `breathing` 呼吸节奏，画面永远不会静止。

### 2. 粒子空间（Particle Space）

粒子活在一套**独立于世界坐标**的局部空间里：粒子在自己的空间生成与循环，整片粒子场通过一个 4×4 矩阵（旋转 / 缩放 / 位移）整体作用到世界。变换在顶点着色器完成，**旋转与呼吸缩放零 CPU 成本**，头显上也能稳帧。

见 `src/core/particle-space.ts`。

### 3. 呼吸宇宙（`breathing-universe`）

无限暗色宇宙里悬浮的一颗半透明能量球：34k 颗发光微粒构成膜质外壳，
56 条光丝既画成线条也画成点云，沿线跑动的光脉冲让结构持续流动。
**4 秒吸气、6 秒呼气**——球体半径、辉光强度、丝线流速都由呼吸相位驱动，
音乐的低频起伏再叠一层二次调制。

相机完全静止，所有周期性运动都以呼吸周期为基准，因此可以无缝无限循环。

配乐用三段曲目首尾相接、交叉淡化连续播放（`audioPlaylist`），
由程序控制音量与低通滤波：吸气时更亮更满，呼气时收窄变柔，
不需要在每次呼吸时切换音频片段。

### 4. 真实感内核

`src/core/lighting.ts` 把三件最有效的真实感能力做成核心层，场景只需声明意图：

- **自动曝光** —— 16×16 小图测平均亮度，像眼睛一样平滑调整曝光
- **实时环境反射** —— `CubeCamera` 抓取场景自身作为环境贴图（PMREM 包装）
- **间接光探针** —— 从同一张立方图烘焙 SH，墙面能接到窗外的天光

### 5. 分层混音与环境预设

场景可以声明**多路声音图层**（`audioLayers`），每路一个独立推子：风声、水声、虫鸣、乐声、雨声……
每路内部是多段素材首尾相接 + 交叉淡化的无缝循环，接缝听不出来。

场景还能声明**环境预设**（`modes`）：晴夜 / 雨夜这类切换会同时改画面与声音配比，
不必整个换场景。`月夜庭院` 就是一个例子 —— 切到雨夜时：

- 云变厚、月亮被压暗、雾更浓、树摆幅更大
- 水面泛起雨点涟漪，天上落下雨丝
- 灯笼的暖光相对更明显
- **雨声图层拉满**，风声更大、虫鸣几乎消失、乐声压低

预设里的音量是**倍率**，叠加在用户自己的推子设置之上 —— 推子决定「这一路要多大」，
预设决定「此刻这一路占多少」。

---

## Vision Pro

### 怎么跑起来

WebXR 只在**安全上下文**（HTTPS 或 localhost）可用。Vision Pro 的 Safari 打开 `localhost` 指的是头显自己，不是你的 Mac —— 所以真机体验需要：

1. **部署到 HTTPS 域名**（GitHub Pages / Netlify / Vercel / Cloudflare Pages 都行，`dist/` 可直接发布）；或
2. 用 `cloudflared tunnel --url http://localhost:5173` 之类拿一个临时 HTTPS 域名。

### 沉浸模式里有什么

- **多层环形空间墙** —— 场景面板分几层环绕你，环视 + 捏合 / 扳机 / 视线停留都能选中
- **手部骨架** —— 真实手指关节与骨骼（程序化生成，不依赖外部手模型）
- **捏合交互** —— 场景里的可交互对象标了 `userData.pinchable`，捏住就能拽：推拉障子门、按下琴键、抓起绸缎的控制环
- **空间音频** —— 音源用 `PositionalAudio` 定位，转头时炉火噼啪声从炉膛方向传来；被墙挡住时高频被吃掉；所有空间音源共享一条程序化混响总线

### AR 模式（放到真实空间）

仅在设备与浏览器支持 `immersive-ar` 和 `hit-test` 时可用。Vision Pro Safari 的沉浸 VR 入口与 AR 放置入口分别检测，后者不能作为 Vision Pro 上已可用的功能承诺。

- 命中测试：屏幕上出现贴合地面的指示环，捏合即放置
- **表面贴合**：直接使用命中结果的位置和朝向放置，不绘制平面检测调试网格；实际可命中的桌面 / 墙面取决于设备
- **可选持久锚点**：仅在设备提供 `requestPersistentHandle()` / `restorePersistentAnchor()` 时保存并恢复位置；未提供时仍可在本次会话中手动放置

真机核对清单见 [`docs/vision-pro-checklist.md`](docs/vision-pro-checklist.md) —— 渲染、空间音频方位、手部骨架、AR 放置、持久锚点、平面贴合、分层混音逐项打勾。

### 已知限制

- **光估计（light-estimation）尚未接入**。已在会话里请求该能力，但 three 的 `XREstimatedLight` 依赖非标准调用，Web 端是否真能拿到数据需要真机确认后再决定是否投入。
- 后处理链（`EffectComposer`）在立体渲染下会先渲单目再复制到双眼，做不出正确的 XR 景深 / 色差。霓虹雨夜场景因此在 XR 下自动改用材质层近似。
- 头显的立体渲染、手部关节，以及兼容 AR 设备的命中测试和持久锚点尚未实测。

---

## 目录结构

```
src/
  core/        核心运行时：舞台 / 环境 / 取景 / 音频 / 粒子空间 / 光照装置
  scenes/      48 个场景，按分类分目录；types.ts 是场景契约
  ui/          呼吸引导
  xr/          WebXR：空间墙、探索器（沉浸 / AR）、手部骨架
  styles/      样式
scripts/       场景回归检查 + 单场景截图 / 像素采样工具
public/
  audio/       33 首配乐（mp3，由 MiniMax 生成）
  models/      glTF 模型素材
```

### 加一个场景

在 `src/scenes/<分类>/<id>.ts` 里导出一个 `SceneDefinition`，然后到 `src/scenes/index.ts` 注册。注册后 `npm run verify` 会把它纳入自动检查。契约见 `src/scenes/types.ts`：`create(ctx)` 返回一个 `SceneInstance`，需要实现 `update(time, delta, ctx)` 与 `dispose()`。

---

## 致谢与素材

- 模型素材来自 [three.js 官方示例仓库](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf)：`RobotExpressive.glb`、`DamagedHelmet`
- 全部 33 首配乐由 MiniMax 音乐生成模型创作（含 Enigma 风格的圣咏质感曲目）

## License

MIT
