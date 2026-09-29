# Prompt Schema 字段设计规范

本文档详述 Prompt 标准 Schema 各字段的设计规范。生成 Prompt 时按需参考。

## Subject 主体

主体必须具体。

避免：`一个女生` / `一个产品` / `一个城市`

优先：`一名年轻亚洲女性骑行者` / `一款极简黑色金属咖啡机` / `现代都市街道上的年轻通勤者`

不得凭空加入用户没有要求且会改变主体性质的重要特征。

## Action / Pose 动作与姿态

人物图片必须尽可能明确：动作、姿势、手部状态、身体方向、视线、表情、与环境的互动。

例：
```
standing beside the bicycle,
one hand holding the handlebar,
looking slightly toward the camera,
natural relaxed posture
```

避免仅使用 `beautiful woman`。

## Environment 环境

环境需要形成空间关系：地点 + 前景 + 主体周围环境 + 背景 + 环境氛围。

禁止无意义堆叠大量场景元素。

## Composition 构图

必须根据图片用途设计构图。

### 人像
`close-up` / `medium shot` / `full-body portrait`

### 产品
`centered composition` / `hero product shot` / `three-quarter view`

### 自媒体封面
重点考虑：主体识别度、视觉中心、文字安全区、移动端观看。

用户明确说明用于抖音/小红书封面时，默认优先考虑移动端竖屏视觉。

## Camera 摄影

摄影类图片可描述：景别、机位、拍摄角度、焦段倾向、景深、对焦位置、动态模糊。

不要为了"专业"而机械堆叠摄影参数。只有能改善画面控制时才加入。

焦段语义表（24/35/50/85/200mm 的情绪与空间效果）、光圈/焦平面指令、机位情绪语义、景别层级（特写→情绪/中景→关系/全景→处境），见 `references/lighting_color_composition.md` 第三节。

## Lighting 光线

根据视觉目标设计：`natural light` / `soft light` / `hard light` / `rim light` / `backlight` / `side light` / `studio lighting` / `cinematic lighting`

必须避免互相冲突的光线描述。

进阶布光词汇（伦勃朗光/分割光/边缘光/顶底光的光向情绪语义、丁达尔/焦散/gobo 现象词、**shadow color 阴影色彩**、负补光写法、强戏剧冲突光影合成公式），见 `references/lighting_color_composition.md` 第一、四节。

## Color 色彩

描述：主色、辅助色、色温、饱和度、明暗关系。

避免无意义堆砌 `red, blue, green, yellow, purple, orange...`。

进阶配色语法（色温对立范式：橙青/琥珀冷蓝/烛金月蓝、饱和度层级的前突/融入效果、环境染色与反弹光），见 `references/lighting_color_composition.md` 第二节。

## Material / Texture 材质

可描述的材质：金属、玻璃、布料、皮革、木材、塑料、皮肤、水面等。

仅在材质对画面质感有实质影响时加入。

### 光学属性必须区分（用户明确要求时显式写出）

描述材质时区分其光学行为，而非只写材质名：

- **镜面反射（高光锐利）**：釉面陶瓷、玻璃、抛光金属、水面、湿表面——写明 specular highlights 的位置与边缘锐度
- **漫反射（无高光）**：亚麻、棉布、纸、泥土、哑光粗陶——写明纤维质感与吸光
- **半哑光**：木材、皮革、皮肤、拉丝金属——高光弱且过渡柔和
- **透射/折射**：玻璃、透明釉层、水——写明"透过 X 可见 Y"（如釉下彩透过透明釉层）

例：`glassy transparent glaze with crisp specular highlights along curved shoulders, under-glaze cobalt pattern visible beneath the glaze surface`（釉面镜面高光 + 釉下彩透射）

金属类三分法（抛光/拉丝/氧化生锈）与"材质词必须与光源词绑定"核心法则，见 `references/subject_environment_medium_guide.md` 第一节第 3 条。

## 时间 / 天气 / 空气氛围

用户要求明确的时间、天气、空气氛围时，必须显式给出：

- **时间**：具体时段（清晨/正午/黄昏/雨后清晨），决定色温与光向
- **天气**：晴/阴/雨/雾——决定光线质感（直射硬光 vs 漫射软光）
- **雨**：雨中（可见雨丝/雨滴）vs 雨后（湿表面反光、水痕、残余雨滴），二选一并保持一致
- **空气**：湿度、水汽薄雾、体积光、尘埃——决定画面的"通透感"与光路可见度

禁止互相冲突：如"阴天漫射光"与"清晰锐利的直射阴影"不可同时出现。

各时段的色温与阴影形态对照表（清晨/正午/黄昏/夜晚）、宏观→中观→微观空间推演、空气透视写法，见 `references/subject_environment_medium_guide.md` 第二节。

## Style 风格

Style 必须服务于视觉目标。例：`commercial photography` / `editorial fashion photography` / `cinematic realism` / `documentary photography` / `minimalist product photography`

避免同时使用大量互相冲突的风格，如同时出现 `photorealistic` + `anime` + `oil painting` + `3D render` + `documentary photography`。

## Negative Prompt

根据模型能力决定是否生成。适用于：人物、产品、复杂场景、手部、文字、Logo、对称结构。

例：
```
deformed hands,
extra fingers,
duplicate objects,
distorted proportions,
unnatural anatomy,
blurry details
```

目标模型不适合 Negative Prompt 时，将约束转换为正向描述。

## 模型适配

采用：`Universal Visual Description → Model Adapter → Final Prompt`

支持扩展模型：GPT Image、Midjourney、Flux、Stable Diffusion / SDXL、即梦、豆包、可灵、其他。

用户未指定模型时：不主动绑定某一个模型，默认输出通用高质量 Prompt。

用户指定模型时：按对应模型习惯优化（如 Midjourney 的 `--ar` 参数、SDXL 的权重语法等）。

### Qwen-Image（1.0/2.0/3.0）适配要点

- **双语原生**：中文 Prompt 与英文 Prompt 效果同级，中文可用原生流畅长句描述，无需直译腔
- **正向描述**：主 Prompt 禁止否定词，约束改写为正向表达（"不要硬光"→"光线柔和漫射、阴影过渡平缓"）；无关信息一律删除。机制原因：正向句内写否定可能**反向激活**被否定的概念（"不要红色"激活红色）
- **强调机制**：自然语言强调（"尤其是""画面核心为"）；括号权重 `(kw:1.5)` 为 SD 系语法，千问多数不支持，若支持仅对单一元素慎用
- **Negative Prompt**：走 API 的 `negative_prompt` 独立参数，不写进主 Prompt 正文
- **画幅**：无 `--ar` 类语法，比例在生成侧/API 参数设置
- **长描述友好**：3.0 支持最大 4.5K token 输入，可承载复杂版面与长三段论结构
- **`prompt_extend`**：API 默认开启智能改写，常规生成保持默认即可
- **注意力权重衰减**：长文本句首/句尾权重高、中段衰减——光影条件紧跟主体材质（"材质-光影"强绑定），画质修饰词收句尾
- **语义对齐**：物理参数（6500K）替换为视觉描述词（"清晨冷蓝调柔和天光"）
- **深度辅助词**：2D 生成难推断 3D 折射，主动补"厚度感/通透感/微弱立体深度"类视觉词

三项机制详见 `references/subject_environment_medium_guide.md` 第四节。
