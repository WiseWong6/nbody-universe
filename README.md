# N-body Universe — 宇宙生成器

由发光粒子组成的三维宇宙模拟原型：受限 N-body 引力 + GLSL 粒子渲染。
本阶段只做宇宙模拟，不含照片上传、音频、登录、数据库与分享。

**Vortex Energy 分支（Visual V3）**：**旋涡能量球引擎**（默认）——
查克拉压缩流模型：向心压缩 + 15 族不规则局部旋向（越近中心角速度越大）
+ Curl Noise 微扰，能量从外缘持续流向中心聚核（螺旋丸式效果原型），
100 条真实历史轨迹流线为视觉主体。
与 N-body 银河共用统一 `ParticleSimulation` 接口、渲染管线与面板，
面板顶部「引擎」下拉或 URL `?engine=galaxy|vortex` 切换。
截图见 `shots/v3-paused.png`（默认暂停）、`shots/v3-run5s.png`（运行 5s）、
`shots/v3-side.png`（侧面）与 `shots/v3-compare.png`（V2/V3 对比）。

**Visual V3**：银河引擎默认进入 **Art Preview 静态预览模式**——物理暂停、镜头固定，
三渲染层（银河光雾面片 + 微小恒星 + 1% 高亮恒星）+ 暗尘带 + 重制核心，
目标是单帧电影感银河。加 `?engine=galaxy&mode=sim` 恢复 N-body 动画模式。
对比见 `docs/v3-compare.png`，成品静帧 `docs/v3-art-preview.png`。

## 运行

```bash
npm install
npm run dev        # 开发，默认 http://localhost:5173（Vortex Energy 引擎）
npm run build      # 类型检查 + 生产构建（tsc --noEmit && vite build）
npm run preview    # 预览构建产物
```

URL 参数：

- `?engine=vortex`（默认）旋涡能量球；`?engine=galaxy` 银河（Art Preview 静态）
- `?paused=1` 打开即暂停（截图/静帧用）
- `?layers=trails|points|none` Vortex 调试图层隔离（只看流线 / 只看粒子）
- `?azim=90` Vortex 侧面取景（默认 28°）
- `?mode=sim` 银河恢复动画模拟；`?preset=hero|spiral|collision|chaos` 指定银河场景
- `?seed=42` 随机种子（两个引擎共用）

### 无头物理验证（可选）

```bash
# N-body：四个预设各 40 秒，NaN/逃逸/距离分布/旋臂 m=2 幅度/确定性指纹
./node_modules/.bin/esbuild scripts/check-sim.mjs --bundle --format=esm \
  --outfile=/tmp/check-sim.bundle.mjs && node /tmp/check-sim.bundle.mjs

# Vortex：30s + 30s 全速，NaN/逃逸率（>1.3R）/中心坍缩/半径漂移/确定性指纹
./node_modules/.bin/esbuild scripts/check-vortex.mjs --bundle --format=esm \
  --outfile=/tmp/check-vortex.bundle.mjs && node /tmp/check-vortex.bundle.mjs
```

## 统一模拟接口

两个引擎实现同一个 `ParticleSimulation` 接口（`src/simulation-interface.ts`）：
`init / update(frameDt) / reset / dispose / syncSpeed`，渲染层（particles.ts）
只依赖共享的 TypedArray（position/velocity/speed/color/starSize/twinkle），
不关心背后是引力还是力场。`update` 内部用固定步长 accumulator 切分，
保证确定性与帧率无关。

## Vortex Energy（旋涡能量球，Visual V3）

**查克拉压缩流模型**（`src/vortex.ts`，无引力、无粒子间作用）：
V2 的「球壳轨道绕圈」（plane/radial 修正把粒子钉在固定轨道面上）已废弃，
改为**向心压缩 + 不规则局部旋转偏折**——能量从外缘持续流向中心、
越近中心旋转越快，形成高旋转密度的聚核球：

```
targetVelocity = inwardCompression + irregularSwirl + turbulence

inwardCompression = -normalize(p) · compression · 0.32R · smoothstep(0.10, 0.45, r/R)
irregularSwirl    = tangent[g] · swirl · 7.5 · ((R+ε)/(r+ε))^0.5 · famSpeedMul[g]
                    tangent[g] = normalize(axis[g] × p)，ε = 0.12R
turbulence        = curlNoise · turbulence · 4   （只占 5%~12% 局部扰动）
accel             = follow·(target − v) − drag·v
```

- **向心压缩**：所有 Flow 粒子有明确的向心速度项（0.45R 以外满强度，
  向内平滑衰减），整体趋势是「向中心收缩」而非球面绕行。
- **径向加速旋转**：角速度 ∝ 1/(r+ε)^0.5——外围查克拉流慢，
  向内流动过程中角速度持续增大，核心处旋转密度最高
  （inward acceleration + angular acceleration）。
- 15 个 Orbit Family 只提供 seed 确定的**局部旋向**（独立旋转轴 +
  0.008~0.02 rad/s 极慢进动），不再绑定固定轨道半径；
  不同粒子群旋转方向不规则交错（Axis Mix 控制离散程度）。
- **回收重生**：流入核心（r < 0.12R）的 Flow 粒子由 seed 确定性
  重生到外缘 0.88~1.0R——维持持续的压缩流，不坍缩成奇点也不逃逸
  （`scripts/check-vortex.mjs`：60s 后逃逸率 0%、中心堆积 0%、确定性 PASS）。
- 积分：固定步长 1/60s 半隐式 Euler，全程 seeded（mulberry32）。

**粒子分组**：85% Flow（全体积 0.12~1.0R cbrt 分布，1.0~1.9px）/
12% Shell / 3% Core。粒子每步按当前半径动态上色（外蓝内白 +
饱和度钳制：rn > 0.15 时 G ≤ 0.36B、R ≤ 0.22B，白色只允许出现在核心）。

**渲染分层**（`src/particles.ts`）：

1. **Main Chakra Trails（视觉主体）**：`createTrailRenderer` 挑选
   100 个 Flow 代表粒子，每个保存 96 格 60Hz 历史位置（环形缓冲，
   **跟随 sim.time 采样**，与 wall-clock 解耦），LineSegments2 fat lines
   （linewidth 4.2px）绘制。颜色由每段历史点半径驱动：尾（外/旧）
   深蓝 → 头（内/新）亮蓝白，中段经亮度衰减（min(rn/0.75,1)）
   与饱和度钳制防止 additive 堆白；回收重生跳变时单条轨迹清零，
   不画横跨球体的直线。是唯一参与明显 Bloom 的层。
   Trail Persistence 只控制可见段数，与物理速度完全解耦。
2. **Spark Particles**：15000 辅助粒子（NormalBlending 普通层 +
   尾部高亮 Additive 层），只作碎光填充，不再是主视觉。
3. **Core Compression**：`createVortexCore` 压缩高斯 billboard（0.5R，
   alpha 0.3）+ 随时间旋动的径向拉伸噪声纹理——亮而有内部层次，
   不成纯白圆洞。
4. **Inner Energy Volume**：`createEnergyHaze` BackSide 体积雾
   （视角中心亮/边缘暗 + 双层 fBm 随时间反向漂移，峰值 alpha 0.05，
   噪声阈值制造局部缺口）——表现查克拉浓度与体积感，不是玻璃壳。

**配色（V4 颜色系统：色相与运动半径解绑）**：
每个 Orbit Family 在 init 时按固定配额分配**稳定基础色**（seed 洗牌：
深蓝 `#075CFF`×4 + 电光蓝 `#0A67FF`×4 + 主体蓝 `#3BB8FF`×6 + 青蓝 `#74E5FF`×1，
≈53% 深蓝/电光蓝、40% 主体蓝、7% 青蓝），运动全程不变；
半径只控制亮度（内层投影密度高，亮度随密度反压，防止 additive 堆白），
并有饱和度钳制（G ≤ 0.62B、R ≤ 0.42B）兜底——任何参数组合都不会漂出白色。
流线头部可以更亮，但永远是蓝；**白色只属于独立的 Core Compression 核心层**：
billboard 上 0.025R 内的小亮点（`uWhiteRadius` 控制），之外立刻消失，
蓝色翼区 alpha≈0。粒子与流线不承担制造白色的职责。
SRGBColorSpace + ACESFilmicToneMapping，exposure 0.9，
Bloom 克制档（strength 0.38 / radius 0.3 / threshold 0.75）——
阈值只拾取最亮的流线头部与核心点，保留蓝色色相，不把高亮蓝漂成纯白。
Trail Opacity 0.65。

### Vortex 参数（面板「旋涡参数」组）

| 参数 | 含义 |
| --- | --- |
| Radius | 球体半径（5~60），默认 24，相机与能量雾随动 |
| Swirl Strength | 旋转强度——切向速度倍率（0~3），默认 0.85 |
| Compression Strength | 压缩强度——向心流速倍率（0~2），默认 **0.7**——需求建议 0.9 实测全部轨迹压进 0.4R 叠成白球，视觉验收优先调低；稳态平均半径 ≈0.31R |
| Axis Mix | 轨道族旋转轴的离散程度（0=近乎同轴，1=全向交错），默认 0.62 |
| Turbulence | Curl Noise 局部扰动强度（0~2），默认 0.1（5~12% 占比） |
| Confinement | 球形约束力（0~3），默认 1.1 |
| Drag | 阻尼（0~1），默认 0.1 |
| Trail Persistence | 流线轨迹持续秒数（0.2~3.0），默认 2.4s；只控制可见段数，与播放速度解耦，实时生效 |
| Blue Saturation | 蓝色饱和度（0~2.5），默认 1.4；围绕 luma 缩放色相纯度，有钳制兜底不漂白，实时生效 |
| Trail Brightness | 流线亮度倍率（0.3~2），默认 1.0；只改明暗不改色相，实时生效 |
| Core White Radius | 核心白半径（0.04~0.2，相对 R），默认 0.1；白色核心亮点的大小，实时生效 |
| Bloom Strength | 泛光强度（0~1.2），默认 0.38；阈值固定 0.75 保留蓝色色相，实时生效 |
| Time Scale | 播放速度（0~1），默认 0.22，实时生效 |
| Particle Count | 桌面默认 15000 / 移动端 8000（粒子降级为辅助层，数量比 V2 减半） |
| Seed / Pause / Reset / Randomize / Bloom | 与银河引擎共用语义 |

## 物理模型（N-body 银河引擎）

**受限 N-body（restricted N-body）**：

- 2~5 个**有质量引力核心**：核心之间按牛顿万有引力互算（O(k²)，k≤5），自身也积分运动——双星系会互相靠近、三体会混沌舞蹈。
- 大量**无质量示踪粒子**：只受核心引力，粒子之间不互算（避免 O(n²)）。

受力（含 softening，防止近距离数值爆炸）：

```
a = Σᵢ  G · mᵢ · (rᵢ − r) / (|rᵢ − r|² + ε²)^(3/2)      ε = 0.9
```

积分器：**Leapfrog KDK**（等价 Velocity Verlet），固定步长 `SIM_DT = 0.006`（模拟秒），
主循环用 accumulator 把渲染帧时间 × Time Scale 切分成整数个物理步，
帧率与播放速度波动都不影响物理轨迹；每帧步数有上限，慢设备上宁可慢动作也不跳变。

**确定性**：所有初始位置/速度由 `mulberry32(seed)` 生成，固定步长、固定计算顺序，
全程不使用 `Math.random`——相同 seed 与参数必得相同结果（`scripts/check-sim.mjs` 有指纹验证）。

**初速度**：以切向圆轨道速度为基础 `v = sqrt(G·M_eff/r)`，Hero 默认倍率 0.98、
扰动 ≤5%（Chaos 0.12），粒子大多进入长期束缚轨道，少量偏心、少量甩出。

## Hero Galaxy（默认预设）

**艺术引导的初始分布 + N-body 后续演化**，不等待 N-body 自行形成银河：

| 结构 | 占比 | 生成方式 |
| --- | --- | --- |
| 中央核球 | 15% | 三维高斯球（较厚），暖白/淡金 |
| 对数螺旋臂 | 50% | 2 条 `r = a·exp(b·θ)`（a=2.5，b=0.34，约 1.2 圈），冷白/淡蓝 |
| 稀疏星盘 | 30% | 指数盘（更薄），冷白 |
| 外围星晕 | 5% | 稀疏球壳，暗淡冷色 |

旋臂的反规整处理（全部由 seed 驱动）：沿半径均匀采样、宽度扰动
（外侧变宽 `w = 0.45 + r·0.09`）、角度扰动、约 18% 粒子的次级分叉臂、
外端密度渐稀（拒绝采样）。

**尘埃带**：seeded 2D value-noise（3 octave fBm）对粒子做拒绝重采（降低密度）
并乘暗化系数（降低亮度），在旋臂之间形成稀疏暗区，无体积烟雾。

**结构保留**：旋臂是物质臂，点核势阱中的差速旋转会逐步卷绕——
开展型臂（b=0.34）+ Time Scale 0.18 下，30 秒真实时间（≈5.4 模拟秒）后
外圈旋臂 m=2 幅度仍保持约 40%（`docs/v2-hero-35s.png`）。

## 渲染（Visual V3）

**Art Preview 三渲染层**（默认静态模式）：

1. **银河光雾层**（`src/glowPlane.ts`）：躺在盘面上的连续发光面片（非粒子）。
   Fragment shader 以双对数螺旋臂距离场为底，加 fBm / domain warping 噪声
   产生疏密、局部断裂、不对称与外侧变宽；旋臂内侧噪声暗尘带；
   中央柔和高斯核球光晕（颗粒调制、亮度上限压在 Bloom 阈值以下）。
2. **微小恒星层**（99% 粒子）：0.35~0.9px、低透明度、`NormalBlending`、
   不参与 Bloom——提供细腻星河颗粒质感，单个粒子不被明显感知。
3. **高亮恒星层**（1% 粒子）：1.5~3.5px（shader 硬上限 4px 防泡沫）、
   `AdditiveBlending`、唯一参与轻微 Bloom 的层，极淡紫低饱和。

**核心**：不再靠粒子堆叠——高斯光晕（暖白淡金 → 淡蓝过渡）+ 收缩的核球粒子
（面积约为 V2 的 40%）+ 亮度上限，保留颗粒层次、无纯白大光斑。

**暗尘带**：双管齐下——光雾层在臂内侧做噪声暗带；粒子生成时沿臂内侧
（perp 负侧窄带）噪声遮罩强暗化 + 拒绝重采，旋臂呈现明暗交错。

**构图**：镜头相对盘面倾斜 25°，银河占画面宽约 70%，视点中心偏离银河核心，
大面积纯黑留白；ACESFilmicToneMapping，exposure 0.7，Bloom 0.35/0.65。

动画模式（`?mode=sim`）沿用 V2 行为：双渲染层 Points、OrbitControls、
Time Scale、自动环绕等全部保留。

## 渲染（Visual V2）

- **双渲染层**：两个 `THREE.Points` 共享同一份 position/speed attribute，
  用 `setDrawRange` 分层，零拷贝零分配：
  - 普通层（星尘 + 普通恒星，95%）：`NormalBlending`，密度再高也不堆白
  - 高亮层（5% 高亮恒星 + 核心辉光）：`AdditiveBlending`，Bloom 主力
- **恒星尺寸层级**：75% 星尘 0.7~1.4px / 20% 普通恒星 1.5~2.8px / 5% 高亮 3~5px；
  尺寸 × DPR × 透视衰减，带下限保证远处不消失
- **闪烁**：约 8% 粒子缓慢闪烁（幅度 0.05~0.15，相位错开，不同步）
- **过曝治理**：核球粒子亮度压到 ~30%；shader 亮度硬上限（uMaxLum=1.1）；
  `ACESFilmicToneMapping` + `toneMappingExposure=0.8`；
  Bloom strength 0.45 / threshold 0.6（普通层基本不参与）——
  核心是温暖、有颗粒层次的星核，不是纯白圆斑
- 镜头：`OrbitControls` 自动环绕降至 0.11（约 V1 的 20%），鼠标/触摸交互不变

## 参数（右上角控制面板）

| 参数 | 含义 |
| --- | --- |
| Preset | 四个预设场景，切换即套用推荐参数并重建 |
| Gravity | 引力常数 G 倍率（0.2~3），Hero 默认 0.85 |
| Rotation | 初始切向速度系数（0~1.6），只管初始角动量，Hero 默认 0.98 |
| Chaos | 速度扰动 + 核心初始位置/速度偏移（0~1），Hero 默认 0.12 |
| **Time Scale** | 播放速度（0~1，默认 0.18），独立于 Rotation，实时生效无需重建 |
| Particle Count | 粒子数（2k~80k），桌面默认 40000 / 移动端 12000 |
| Seed | 随机种子，同 seed 同参数结果完全一致 |
| Pause / Resume | 暂停/继续物理步进（渲染与镜头继续） |
| Reset | 按当前参数重新生成 |
| Randomize | 随机换 seed 并重建 |
| Bloom | 后期泛光开关 |
| Debug HUD | FPS / 粒子数 / 物理步数 调试层开关 |

### 预设

1. **Hero Galaxy**（默认）：艺术引导银河，第一眼即有核球/双臂/暗区/星晕。
2. **Spiral Galaxy**：单核心 + 指数盘，验证基础视觉与轨道结构。
3. **Galaxy Collision**：两个带盘星系相向掠过，可见靠近、潮汐拉伸、交错成桥。
4. **Three-body Chaos**：三个近似束缚的核心混沌舞蹈，粒子被反复撕裂甩出。

## 性能

- 银河：桌面默认 40000 粒子 / 移动端 12000；Vortex：桌面 15000 / 移动端 8000，DPR 上限 2。
- 全部粒子状态存 TypedArray，每帧零分配：就地更新 `position`/`aVel`/`aSpeed` attribute；
  流线直接写 LineSegments2 底层 InterleavedBuffer。
- 实测（Apple M2 Pro，真 GPU）：银河 40000 粒子 + 双层渲染 + Bloom ≈ 75 FPS；
  Vortex 15000 粒子 + 100 条流线 + 体积雾 ≈ 75 FPS（远超 45 FPS，无需 GPUComputationRenderer）。
- 重建/销毁时释放 `Geometry`、`Material`、`RenderTarget` 与事件监听；
  页面隐藏（`visibilitychange`）时暂停模拟与渲染。

## 代码结构

```
src/
├── main.ts                 # 入口：引擎切换（vortex 默认 / galaxy）+ 主循环
├── simulation-interface.ts # 统一 ParticleSimulation 接口
├── simulation.ts           # NBodySimulation：受限 N-body + Hero 艺术引导分布
├── vortex.ts               # VortexFieldSimulation：向心压缩流 + Orbit Family 局部旋向 + 回收重生 + Curl Noise
├── glowPlane.ts            # V3 银河光雾层：螺旋臂距离场 + fBm/domain warp + 暗尘带 shader
├── presets.ts              # 四个银河预设：核心质量/位置/速度/粒子盘参数
├── rng.ts                  # mulberry32 确定性随机 + 高斯采样 + seeded 2D/3D value-noise
├── particles.ts            # 双渲染层 Points/ShaderMaterial + TrailRenderer 真实流线 + 核心辉光 + 破碎能量雾
├── renderer.ts             # 场景/相机/OrbitControls/ACES/Bloom/银河与 Vortex 取景
├── ui.ts                   # lil-gui 中文面板（引擎切换 + 两组参数 + ? 帮助）+ FPS 调试层
└── types.ts                # 参数、预设类型与推荐参数表（含 DEFAULT_VORTEX）
scripts/check-sim.mjs       # N-body 无头稳定性 + 旋臂结构 + 确定性验证
scripts/check-vortex.mjs    # Vortex 无头 60s 稳定性 + 约束/坍缩 + 确定性验证
docs/                       # V1/V2/V3 对比与场景截图
shots/                      # Vortex 双视角截图与银河回归截图
```

## 后续：接入照片生成初始粒子分布

当前粒子初始分布在 `Simulation.build()` 中由「结构采样器」（Hero）或
「指数盘采样器」（经典预设）生成。接入照片时，只需新增一个**照片采样器**，
物理与渲染无需改动：

1. **像素 → 概率分布**：把照片缩到 ~256²，取亮度（或 alpha）作为拒绝采样/
   逆 CDF 采样的权重，亮部产生更多粒子。
2. **像素 → 位置**：把采样到的 `(u, v)` 映射到盘平面坐标
   （`x = (u−0.5)·W`, `z = (v−0.5)·H`, `y = 高斯薄厚度`），
   即得到照片形状的初始粒子云；也可按亮度给 y 方向浮雕高度。
3. **像素 → 颜色**：直接把该像素颜色写入 `this.color`（替换
   「按结构分区着色」逻辑），即可让粒子云携带照片色彩；
   恒星类别/尺寸/闪烁的分类逻辑可直接复用。
4. **初速度不变**：仍按 `v = sqrt(GM_eff/r)` 给切向速度——照片粒子云会在
   引力下逐渐旋转、剪切、弥散成星系，这正是这个原型的看点。

建议的接入方式：在 `Simulation` 增加
`initFromSampler(sampler: { position(i): [x,y,z]; color(i): [r,g,b] }, count)`，
由 `main.ts` 在「照片模式」下传入；预设/参数面板与物理循环完全复用。
