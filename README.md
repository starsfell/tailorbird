# tailorbird

本地运行的网页端鸟摄照片筛选工具。Sony A7R5 优化(ARW + HIF 双格式),也支持 NEF / CR2 / CR3 / RAF / ORF / RW2 / DNG / HEIF / JPEG。

**全部处理在本地,不上传任何照片。** macOS Apple Silicon · Python 3.11 · React + Vite

---

## 目录

- [项目目标](#项目目标)
- [核心功能](#核心功能)
- [三种视图](#三种视图)
- [0-3 星评分算法](#0-3-星评分算法)
- [删除与整理](#删除与整理)
- [快捷键](#快捷键)
- [快速开始](#快速开始)
- [AI 模型](#ai-模型)
- [性能](#性能)
- [项目结构](#项目结构)
- [REST API 参考](#rest-api-参考)
- [数据库 Schema](#数据库-schema)
- [3 档预设的阈值](#3-档预设的阈值)
- [开发与调试](#开发与调试)
- [故障排查](#故障排查)
- [仍未做 / Roadmap](#仍未做--roadmap)
- [与 SuperPicky.APP 的关系](#与-superpickyapp-的关系)
- [平台与依赖](#平台与依赖)
- [许可](#许可)

---

## 项目目标

Sony A7R5 一次连拍下来动辄上千张 ARW + HIF。后期最耗时的不是修图,而是**从一千张里挑出眼睛锐的那几张**。tailorbird 把这件事自动化:

1. **抽预览不解 RAW** — 直接读 ARW 内嵌的全分辨率 JPEG,处理速度跟 JPEG 一样快;
2. **多模型协同打分** — YOLO 找鸟、关键点找眼、TOPIQ 算美学、SuperFlier 识飞鸟、直方图判过/欠曝;
3. **连拍组聚类** — 时间窗 + pHash 把同一波连拍归为一组,每组只保留最佳;
4. **0-3 星 + Pick 标记** — 一键选中所有低星和组内非最佳,移到 `ToReview/` 或废纸篓;
5. **EXIF 写回** — 星级和 Label 写进 XMP,Lightroom / Capture One 直接读。

一句话流程:目录拖进来 → AI 自动评 0-3 星 → 一键选所有低星和组内非最佳 → 移到 `ToReview/` → 高星片写星级到 EXIF,在 Lightroom 里继续后期。

---

## 核心功能

### 智能筛选(对齐 SuperPicky.APP 的核心能力)

| 维度 | 实现 |
|---|---|
| 鸟检测 | YOLO11l-seg(Ultralytics),只在 bbox 内打分,背景虚化不误判 |
| 眼睛关键点 | CUB-200 训练的 ResNet50,定位左眼/右眼/喙,可见度 0-1 |
| 眼部锐度 | 眼周 64×64 窗口的 Laplacian + Tenengrad |
| 美学评分 | TOPIQ (CFANet + ResNet50, AVA 数据集),输出 0-10 |
| 飞鸟检测 | SuperFlier EfficientNet-B3 二分类 |
| 过 / 欠曝 | bird bbox 内直方图,>10% 像素 ≥235 = 过曝 |
| 相机 AF 点 | 解析 Sony / Nikon / Canon / Fuji / Olympus / Panasonic MakerNote |
| 焦点距眼距离 | 1.1(头部)/ 1.0(SEG 内)/ 0.7(BBox 内)/ 0.5(框外) 权重 |
| 0-3 星 + Pick | 综合锐度 + 美学 + 焦点权重 + 眼可见度 + 曝光; Pick = 3 星中 top 25% |
| 3 档预设 | 新手 / 初级 / 大师,不同阈值组合 |

### 连拍处理

- 时间窗 (2 秒) + pHash (汉明 ≤ 8) 聚类
- 每组按眼部锐度排序,自动标推荐保留
- ARW + HIF 同 stem 视为一个 shot,不重复计数

### 快速分类标签

侧栏一键过滤:**无鸟 / 0★ / 脱焦 / 精焦 / 过曝 / 欠曝 / 飞鸟**。配合「最低星级」和「只看 Pick」两个开关,可以快速定位想看的子集。

---

## 三种视图

| 视图 | 用途 |
|---|---|
| **网格视图** | 按连拍组分块显示,组内最佳绿框高亮,组首带「选中本组非最佳」按钮 |
| **连拍组视图** | 紧凑横排显示每组,适合一组一组快速判断 |
| **相似图片视图** | 跨整个目录用 pHash 找视觉上相似的照片(忽略时间),适合清理在不同时段重复拍同一个角度的情况 |

**详情视图(双击 / Space 进入)**:
- 滚轮缩放 / 拖动平移 / 双击切换 100% / J / K / ← / → 翻图
- 红框 = 相机记录的 AF 焦点
- 绿框 = YOLO 检测的鸟主体
- 黄点 = AI 推测的鸟眼位置
- 头部「手动标注」按钮:进入标注模式 → 拖动画鸟框 → 点击鸟眼位置 → 保存。后端立刻重算 `subject_sharpness` / `eye_sharpness` / `focus_weight` / `rating`,并同步到 ARW+HIF 同组所有文件。用于挽救 AI 漏检的鸟。

**多图对比(C 键)**:选 2–9 张:
- 默认**全部联动** — 所有图共享 500% 缩放和平移,锚点优先级: 鸟眼 > 鸟框中心 > 图心
- 拖任意一张所有图同步移动;滚轮缩放所有图同步缩放,每张围绕自己的锚点
- 源像素 6400px,在 Retina 屏 500% 下接近 1:1 像素
- **S** 一次切换联动 / 独立 · **0** 重置到初始 · **Esc** 关闭 · 单元格里的「删」按钮可即时丢弃

---

## 0-3 星评分算法

简化版逻辑(详见 `backend/app/core/rating.py`):

```
最终分 = sharpness * focus_weight + aesthetic_bonus + flying_bonus
        - over_penalty - under_penalty

if rating == -1: 没检测到鸟
if rating == 0:  有鸟但锐度/美学/焦点都不达标
if rating == 1:  达到当前预设的最低阈值
if rating == 2:  达到当前预设的目标阈值
if rating == 3:  锐度 + 美学 + 焦点 + 眼可见度全 OK

pick = 1 ⇔ rating == 3 且分数在所有 3 星中位于 top 25%
```

锐度尺度是 tailorbird 自己的混合度量:`sqrt(Laplacian) * 0.6 + sqrt(Tenengrad) * 1.2`,典型鸟片范围 5–80。这个度量对鸟眼这种细节高频区域更敏感,胜过单一 Laplacian。

`focus_weight` 反映相机 AF 点离鸟眼的远近 —— 是 tailorbird 跟 SuperPicky 评分逻辑的核心一致点,也是「相机说对焦在眼上 vs 实际拍出来眼模糊」的判别依据。

---

## 删除与整理

- **EXIF 写回**:把 0-3 星、Pick、飞鸟 Label 写入 XMP,Lightroom / Capture One / Bridge / Finder 都能读;清除按钮可一键擦掉星级 XMP。
- **删除两种模式** (UI 切换):
  - **移到子文件夹**(默认,推荐):在每张照片**所在目录**建 `ToReview/`(例如 `<scan>/100MSDCF/ToReview/`),可在 Finder 直接拖回。
  - **送系统废纸篓**:走 macOS Trash,符合系统习惯。
- 「在 Finder 中打开」按钮通过 `/api/find-move-target` 递归查找扫描根下所有同名子目录,**优先打开非空那个**,确保不会被误开到一个空目录。
- **成对删除**:默认 ARW + HIF 同 stem 一起处理(可关)。

---

## 快捷键

| 键 | 动作 |
|---|---|
| 单击 | 选中 / 取消选中 |
| 双击 / Space | 打开详情视图 |
| A | 全选当前视图 |
| Esc | 清空选择 / 关闭弹窗 |
| B | 选中所有「非组内最佳」(连拍组里除最佳之外的) |
| C | 对比选中的(2–9 张) |
| D | 删除选中 |
| J / → | 详情页下一张 |
| K / ← | 详情页上一张 |
| S | 对比页切换同步 / 独立缩放 |

---

## 快速开始

三种启动方式,日常用 `.app` 双击最省事:

```bash
# 1. 双击 .app(日常使用)
#    第一次:把 tailorbird.app 拖到 /Applications,然后 Launchpad / Spotlight 搜 "tailorbird"
#    内部会自动 build 前端 + 起后端 + 开浏览器;Cmd-Q 干净退出
open /Applications/tailorbird.app

# 2. 生产模式(命令行版,等价于 .app 内部跑的)
#    单端口 7891,前端由 FastAPI 静态托管,改前端要重新 build(脚本会自动判断)
./scripts/start_prod.sh

# 3. 开发模式(前端热重载)
#    后端 7891 + 前端 5173 两个进程,改前端 vite 实时刷新
./scripts/start.sh

# 想完全手动也行
conda activate tailorbird
cd backend && PYTHONPATH=. uvicorn app.main:app --port 7891   # 终端 1
cd frontend && npm run dev                                     # 终端 2
```

浏览器会自动打开:
- `.app` / `start_prod.sh` → http://127.0.0.1:7891(单端口)
- `start.sh` → http://localhost:5173(被占用会落到 5174),后端在 7891

**首次扫描会下载 ~470 MB 模型权重**(走 Hugging Face),需稳定网络。后续启动只读本地。

### tailorbird.app 是怎么打包的

不是 Tauri/Electron,就是手写的 macOS bundle:`Contents/MacOS/tailorbird` 一行 `exec` 调 `scripts/start_prod.sh`,`Contents/Resources/AppIcon.icns` 由 `assets/AppIcon.svg` 生成。`ROOT` 在 launcher 里写死成项目绝对路径——所以**项目目录别改名/搬位置**;真要搬,改一下 `tailorbird.app/Contents/MacOS/tailorbird` 里那行 `ROOT=` 就行。Cmd-Q 通过 SIGTERM 关 uvicorn,端口自动释放。

---

## AI 模型

启动时**按需懒加载**,空载时后端只占 ~70 MB。第一次 AI 推理会一次性加载所有模型(峰值 ~3 GB RAM,主要是 TOPIQ + YOLO11l-seg)。

| 文件 | 大小 | 用途 | 来源 |
|---|---|---|---|
| `yolo11l-seg.pt` | 53 MB | 鸟检测 + 分割 | Ultralytics 官方 |
| `cub200_keypoint_resnet50_slim.pth` | 95 MB | 鸟眼关键点 | HF `jamesphotography/SuperPicky-models` |
| `cfanet_iaa_ava_res50-3cd62bb3.pth` | 280 MB | TOPIQ 美学 | HF `chaofengc/IQA-PyTorch-Weights` |
| `superFlier_efficientnet.pth` | 41 MB | 飞鸟分类 | HF `jamesphotography/SuperPicky-models` |

第一次启动自动下载到 `data/models/`,后续走本地。

---

## 性能

测试机:M 系列 Apple Silicon,MPS 加速。

| 阶段 | 速度 |
|---|---|
| 扫描 + 抽预览 + 清晰度 + pHash | ~4 张 / 秒(多线程) |
| AI 全流程(单张 shot) | ~1.5 秒(YOLO 0.3s + 眼 0.02s + TOPIQ 0.65s + 飞 0.3s + 曝光 0.05s) |
| 详情视图打开 | ~50 ms(ARW 实时抽 JPEG 预览,无磁盘缓存) |
| 对比视图打开(9 张 6400px) | ~1-2 秒(并行解码) |
| 二次扫描同目录 | 秒开(SQLite 缓存) |

**1000 张 ARW 全流程预估**:扫描 2–3 分钟 + AI 25 分钟,后续筛选 / 删除均为秒级。

---

## 项目结构

```
tailorbird/
├── backend/                         Python 3.11 + FastAPI
│   ├── app/
│   │   ├── main.py                  REST API (扫描 / 列表 / 删除 / EXIF 写)
│   │   ├── config.py                预设、目录、端口
│   │   ├── core/
│   │   │   ├── decode.py            ARW 内嵌 JPEG 抽取 + HIF 解码
│   │   │   ├── exif.py              exiftool 包装 + 多厂商 AF 点解析
│   │   │   ├── exif_writer.py       XMP rating / label 写回
│   │   │   ├── sharpness.py         Laplacian + Tenengrad 混合锐度
│   │   │   ├── hashing.py           pHash + 汉明距离
│   │   │   ├── exposure.py          过 / 欠曝直方图判定
│   │   │   ├── scanner.py           多线程扫描 + 聚类
│   │   │   ├── rating.py            0-3 星评分引擎
│   │   │   ├── ai_yolo.py           YOLO11 鸟检测
│   │   │   ├── ai_keypoint.py       CUB-200 鸟眼关键点
│   │   │   ├── ai_topiq.py          TOPIQ 美学
│   │   │   ├── ai_flying.py         SuperFlier 飞鸟分类
│   │   │   ├── ai_pipeline.py       AI 全流程编排(shot 级)
│   │   │   ├── similar.py           全目录 pHash 相似图片分组
│   │   │   ├── deleter.py           送废纸篓
│   │   │   └── file_mover.py        移到子文件夹
│   │   └── db/schema.py             SQLite 表 + 自动迁移
│   └── scripts/
│       └── backfill_focus.py        一次性 EXIF 回填脚本
├── frontend/                        React + Vite
│   └── src/
│       ├── App.jsx                  主框架 + 状态管理 + 侧栏
│       ├── Grid.jsx                 网格(按 cluster 分块)
│       ├── Clusters.jsx             连拍组横排视图
│       ├── SimilarView.jsx          相似图片分组视图
│       ├── Tile.jsx                 单张卡片(星级 / 徽章)
│       ├── PanZoom.jsx              可缩放可拖动的图片视口(支持叠加层)
│       ├── DetailView.jsx           详情页 + AF / 鸟框 / 眼位叠加
│       ├── Compare.jsx              多图同步缩放对比
│       └── api.js                   REST 客户端
├── data/                            运行时数据(不入 git)
│   ├── tailorbird.db                SQLite
│   ├── thumbs/                      320px 缩略图 (~30 KB / 张)
│   └── models/                      AI 模型权重 (~470 MB,首次启动从 HF 自动下载)
├── assets/                          品牌资源
│   ├── BIRDFOLIO_LOGO.svg           原始 logo(来自 birdfolio 项目)
│   └── AppIcon.svg                  1024×1024 圆角图标源 (重新生成 .icns 用)
├── tailorbird.app/                  macOS 双击启动器
│   └── Contents/
│       ├── Info.plist               bundle metadata + CFBundleIconFile
│       ├── MacOS/tailorbird         一行 exec 调 start_prod.sh 的壳脚本
│       └── Resources/AppIcon.icns   多尺寸图标 (16~1024 + @2x)
└── scripts/
    ├── start.sh                     开发模式: 后端 + 前端两个端口
    └── start_prod.sh                生产模式: 单端口,前端 build 后由 FastAPI 托管
```

---

## REST API 参考

后端默认监听 `http://127.0.0.1:7891`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/scan` | 启动一次扫描(body: `{folder, run_ai}`) |
| `GET` | `/api/scan/status` | 当前扫描阶段 + 进度 |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/folders` | 扫描过的目录列表 |
| `GET` | `/api/photos` | 单张照片列表(可按 folder / cluster / sharpness 过滤) |
| `GET` | `/api/shots` | shot 级列表(ARW + HIF 合并成一项,前端主用) |
| `GET` | `/api/clusters` | 连拍组列表 |
| `GET` | `/api/similar-groups` | 跨时间相似图片分组(pHash 阈值可调) |
| `GET` | `/api/photo/{id}/detail` | 详情数据(EXIF / AF / 评分细节) |
| `GET` | `/api/thumb/{id}` | 320px 缩略图(image/jpeg) |
| `GET` | `/api/full/{id}?max_side=N` | 高分辨率预览 |
| `POST` | `/api/delete` | 删除(body: `{photo_ids, pair_with_sidecar, mode, subfolder_name}`) |
| `POST` | `/api/exif/write` | 把星级 / Pick / Label 写入 XMP |
| `POST` | `/api/exif/clear` | 清除星级 XMP |
| `POST` | `/api/annotate` | 用户手动覆盖鸟框 / 眼位,重新计算 |
| `GET` | `/api/presets` | 预设列表 |
| `POST` | `/api/presets/apply` | 应用预设(只重算评分,不重跑 AI) |
| `POST` | `/api/recompute` | 重新聚类 + 评分(`run_ai=true` 也重跑 AI) |
| `GET` | `/api/history` | 最近删除批次 |
| `POST` | `/api/open-folder` | 在 Finder 打开本机路径(限于扫描过的目录子路径) |
| `GET` | `/api/find-move-target?folder=&name=` | 递归找扫描根下叫 `name` 的子目录,带文件数和 mtime |

所有改写操作都先写 SQLite 再返回,失败 rollback。删除走 `send2trash` 或 `shutil.move`,**不直接 `os.remove`**。

---

## 数据库 Schema

SQLite,WAL 模式,启动时通过 `ALTER TABLE` 自动迁移新列。

**folders**

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `path` | TEXT UNIQUE | 扫描根的绝对路径 |
| `last_scanned_at` | REAL | unix timestamp |

**photos**(核心表)

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `folder_id` | INTEGER FK | 所属扫描根 |
| `path` | TEXT UNIQUE | 文件绝对路径 |
| `stem`, `ext` | TEXT | 用于 ARW+HIF 配对 |
| `size`, `mtime`, `shot_at` | INTEGER / REAL | 文件元数据 + 拍摄时间 |
| `width`, `height` | INTEGER | 像素尺寸 |
| `thumb_path` | TEXT | 缩略图缓存路径 |
| `subject_sharpness`, `eye_sharpness` | REAL | 鸟体 / 眼部锐度 |
| `sharpness_pct` | REAL | 同目录百分位排名 |
| `aesthetic_score` | REAL | TOPIQ 0–10 |
| `bird_confidence` | REAL | YOLO conf |
| `bird_bbox`, `eye_xy` | TEXT (json) | 归一化 [x,y,w,h] / [x,y] |
| `eye_visibility` | REAL | 0–1 |
| `focus_point` | TEXT (json) | EXIF MakerNote 解析出的 AF 框 |
| `focus_weight` | REAL | 1.1 头部 / 1.0 SEG / 0.7 BBox / 0.5 外 |
| `is_flying`, `flying_confidence` | INTEGER / REAL | SuperFlier 输出 |
| `is_over`, `is_under`, `over_ratio`, `under_ratio` | INTEGER / REAL | 过/欠曝判定 |
| `rating` | INTEGER | -1 无鸟 / 0–3 星 |
| `pick` | INTEGER | top 25% of 3-star |
| `phash`, `cluster_id`, `is_cluster_best` | TEXT / INTEGER | 连拍聚类 |
| `user_mark` | TEXT | 用户手动标记 |
| `deleted_at` | REAL | 软删标记(走 trash 或 move 后置位) |
| `error` | TEXT | 处理异常信息 |
| `analyzed_at` | REAL | AI 完成时间 |

**deletion_history**:`batch_id` + `original_path` 记录每次删除,留出未来「撤销」的接口。

---

## 3 档预设的阈值

可在 `backend/app/config.py` 里调整。

| 预设 | 锐度达标 | 美学达标 | 最低锐度 | 最低美学 |
|---|---|---|---|---|
| 新手 (宽松) | 22 | 4.5 | 8 | 3.5 |
| 初级 (平衡) | 30 | 4.8 | 12 | 4.0 |
| 大师 (严格) | 42 | 5.5 | 18 | 4.5 |

切换预设**只重算评分**(秒级),不重跑 AI。如果改了评分公式想全量重算:

```bash
curl -X POST http://127.0.0.1:7891/api/recompute \
  -H "Content-Type: application/json" \
  -d '{"run_ai": false, "preset": "intermediate"}'
```

加 `"run_ai": true` 会重跑 AI(慢),只想换预设阈值就保持 false(秒级)。

---

## 开发与调试

```bash
# 后端(自动 reload)
cd backend
PYTHONPATH=. uvicorn app.main:app --port 7891 --reload

# 前端(HMR)
cd frontend
npm run dev

# 看后端日志
tail -f data/backend.log

# 直接查 SQLite
sqlite3 data/tailorbird.db "SELECT rating, COUNT(*) FROM photos WHERE deleted_at IS NULL GROUP BY rating;"
```

**数据库迁移**:`schema.py` 的 `init_db()` 在启动时自动 `ALTER TABLE` 加新列。旧数据库兼容,无需手动迁移。

**清除 AI 结果重算**:删 `data/tailorbird.db` 重新扫描即可。缩略图缓存 `data/thumbs/` 可保留(scanner 会自动跳过已存在的)。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 启动报「找不到 tailorbird conda 环境」 | 先 `conda create -n tailorbird python=3.11`,然后 `pip install -r backend/requirements.txt` |
| 「在 Finder 中打开」提示「还没有移动过文件」 | 当前扫描根下没有任何 `ToReview/` 子目录;先做一次移动操作就有了 |
| AI 阶段卡住 | 看 `data/backend.log`,通常是首次从 HF 下载模型,网络慢 |
| 同一张照片显示两遍 | 检查 ARW + HIF 是否同 stem,不同 stem 会被当作两张独立 shot |
| 详情视图打不开 | 看后端有没有报「rawpy can't extract thumb」;有些第三方 RAW 没有内嵌全分辨率预览 |
| 对比视图无鸟图黑屏 | 老版本 bug,已修复:无鸟图现在以图心为锚点参与联动;若仍黑,Cmd+Shift+R 强刷 |
| HF 模型下载失败,SSL 错误 | 装 `socksio`:`pip install socksio`,然后再试一次 `python scripts/download_models.py` |

---

## 仍未做 / Roadmap

- [ ] 鸟种识别(11000+ 种):SuperPicky 模型加密用不了,需另寻方案
- [ ] 自动按星级整理到 `0star / 1star / 2star / 3star` 子文件夹
- [ ] 从 ToReview / 废纸篓批量恢复(`deletion_history` 已记录,接口未做)
- [ ] PyInstaller 打包成单个 `.app`,双击启动
- [ ] Windows / Linux 适配(目前只测过 macOS Apple Silicon)
- [ ] 删除操作的「撤销最近一批」按钮(数据已备好)
- [ ] 相似分组结果的客户端防抖,大目录拖滑块时不抖

---

## 与 SuperPicky.APP 的关系

tailorbird 在功能设计和模型选型上**借鉴**了开源项目 [SuperPicky.APP (GPL-3.0)](https://github.com/jamesphotography/SuperPicky),包括:

- 0-3 星评分公式骨架
- YOLO11 + CUB-200 keypoint + TOPIQ + SuperFlier 的模型组合
- Sony / Nikon / Canon / Fuji / Olympus / Panasonic 的 AF 点 EXIF 字段名

tailorbird 的所有 Python / JS 代码均独立编写,**不复制 SuperPicky 源码**,只在权重文件层面复用 HF 上的开源 checkpoint。模型权重各自遵循原始发布方协议。

---

## 平台与依赖

- macOS Apple Silicon(M1 / M2 / M3 / M4),走 PyTorch MPS 加速
- Python 3.11(conda env `tailorbird`)
- Node.js 18+
- `brew install exiftool`
- 主要 Python 依赖:`torch` / `torchvision` / `ultralytics` / `pyiqa` / `rawpy` / `pillow-heif` / `opencv-python` / `imagehash` / `fastapi` / `uvicorn` / `send2trash` / `pyexiftool` / `huggingface_hub` / `timm`

---

## 许可

本项目代码以 **GPL-3.0** 发布,与所参照的 SuperPicky.APP 保持一致。

模型权重不在本仓库内,各自遵循其原始来源的协议:Ultralytics YOLO11 (AGPL-3.0) / SuperPicky 上传至 HF 的 keypoint / flier 权重 / TOPIQ 权重。
