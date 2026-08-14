# MINERU·PRESS — 基于 MinerU + Daytona 的多格式内容提取工具

用户上传 PDF / Word(DOCX) / Excel(XLSX) / PPT(PPTX) / 图片(PNG/JPG 等) 文件，
通过 **Daytona 云沙箱中预装的完整 MinerU 3.x** 完成内容提取（→ Markdown + 图片产物），
结果回传并保存到本地，可在 Web 界面直接查看正文、文件清单与运行日志。

## 架构

```
┌────────────┐   上传    ┌──────────────────┐   REST API   ┌─────────────────────┐
│ 本地 Web UI │ ────────▶ │  server.js (Express)│ ──────────▶ │   Daytona Cloud      │
│ 上传/查看   │ ◀──────── │  任务队列/状态存储  │ ◀────────── │  （快照/沙箱/toolbox） │
└────────────┘   结果    └──────────────────┘   下载        └─────────────────────┘
                                   │                                   │
                              data/jobs/<id>/output/           沙箱内: mineru -p ... -o ...
                              保存提取产物到本地                    (2核/4G/10G 常驻沙箱)
```

- **镜像**：`docker/MinerU.Dockerfile`（python:3.11-slim + CPU 版 torch + `mineru[core]>=3.4.0` + 中文字体）。
  通过 Daytona 沙箱创建的 `buildInfo` 机制在云端构建，覆盖 PDF/图片/DOCX/PPTX/XLSX 全部格式。
- **沙箱生命周期**：首次运行自动构建镜像并创建常驻沙箱（约 5-15 分钟），之后任务直接复用；
  24h 无活动自动停机（磁盘保留），7 天自动销毁，均可在 `.env` 调整。
- **任务执行**：上传文件到沙箱 → `mineru --backend pipeline` 后台运行（长任务轮询）→
  产物（markdown + 图片等）通过签名 URL 回传 → 保存到本地。

## 快速开始

### 1. 准备 Daytona API Key（关键！）

- 推荐：**Full Access**（Daytona 控制台 → API Keys）。当前工具默认走**快照模式**：
  构建一次「含 MinerU + 已烘焙模型」的快照（约 5-20 分钟），之后沙箱从快照**秒开（~10s）且模型自带**，
  销毁重建零成本。
- 若只有 **Sandboxes Access**：工具自动降级为 buildInfo 模式（镜像缓存秒开，模型首次运行时下载），同样可用。

```bash
# .env
DAYTONA_API_Key=dtn_xxxxxxxx
DAYTONA_API_URL=https://app.daytona.io/api   # 或 https://app.daytona.io（工具会自动补 /api）
```

### 2. 安装并启动

```bash
npm install
npm start        # http://127.0.0.1:3088
```

### 3. 使用

1. 打开 http://127.0.0.1:3088
2. 点击右上角「初始化环境」（或直接上传文件，工具会自动初始化）
   - 首次：云端构建 MinerU 镜像 + 创建沙箱 + 下载模型（约 10-20 分钟，日志可见进度）
3. 拖拽文件到上传区 → 自动排队执行 → **提取完成后自动入库知识库**
   - 支持**多文件同时选择**、拖拽批量
   - 支持 **ZIP 批量导入**：压缩包内所有文档（含子目录）自动解压入队，
     不支持的格式自动跳过（支持: PDF / DOCX / XLSX / PPTX / 图片）
4. **工作台**：点击任务查看正文（Markdown + KaTeX 公式渲染）/ 文件清单 / 运行日志；
   **「⤓ 导出 PDF」** 一键下载与正文一致的 PDF（服务端 marked + KaTeX 渲染 → headless Chrome 输出，公式/表格/图片/中文全保真，带页码页脚）
5. **知识库**（顶部切换）：全文检索已入库文档内容（中文/英文均可），
   命中结果高亮显示，点击直达原文档正文；支持"已入库文档"浏览

结果保存在 `data/jobs/<任务id>/output/`，任务索引在 `data/jobs/index.json`，
知识库（文档 + 全文索引）在 `data/knowledge.db`（SQLite，可直接用 SQL 查询）。

## 环境变量（.env 可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3088 | 本地服务端口 |
| `SANDBOX_CPU` / `SANDBOX_MEMORY_GB` / `SANDBOX_DISK_GB` | 2 / 4 / 10 | 沙箱资源（受账户配额上限约束，实测磁盘≤10G、内存≤4G） |
| `AUTO_STOP_MINUTES` | 1440 | 无活动自动停机分钟数（0=禁用） |
| `TTL_MINUTES` | 10080 | 沙箱寿命上限（7 天） |
| `WARM_UP` | true | 首次初始化时下载模型（预热） |
| `JOB_TIMEOUT_MIN` | 30 | 单个任务超时 |
| `MAX_UPLOAD_MB` | 300 | 上传大小上限 |
| `BUILD_MODE` | auto | build / snapshot / runtime（强制指定模式） |
| `MINERU_FORMULA` | true | false 时关闭公式识别（省内存/磁盘） |
| `EMBEDDING_API_KEY` | — | 语义检索：Embedding API key（OpenAI 兼容） |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | Embedding API 地址（通义/硅基/智谱等兼容服务均可） |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding 模型名 |

## 语义检索（混合检索）

- 配置 `EMBEDDING_API_KEY`（OpenAI 兼容接口，如 OpenAI / 通义百炼 / 硅基流动等）后：
  新入库文档自动生成向量；历史文档在服务启动时自动补齐
- 知识库搜索支持三种模式：**混合**（关键词 + 语义 RRF 融合，默认）/ **关键词** / **语义**
- 未配置 Embedding API 时自动降级为关键词检索，不影响使用
- 向量存储层可替换：当前存 SQLite（适合中小规模），迁移 Supabase（pgvector）
  或本地模型时仅需更换 `lib/embedding.js` 适配器

## 模式说明（自动降级）

1. **snapshot**（默认，需 Full Access / 快照权限）：构建含 MinerU + 烘焙模型的快照，
   沙箱从快照秒开、模型自带（`BAKE_MODELS=true` 默认开启，`SNAPSHOT_CLASS` 可调沙箱类）
2. **build**：沙箱创建时构建 MinerU 镜像并指定资源 — Sandboxes Access key 可用 ✅
3. **runtime**（最后兜底）：默认小沙箱内 pip 安装 — 1G 内存下大型文档会被 OOM，不推荐

模式选择结果持久化在 `data/state.json`。

## 已验证（2026-08 实测）

- ✅ Daytona Cloud REST API：沙箱创建（buildInfo / 快照两种模式）、快照构建（含模型烘焙）、
  toolbox 代理认证、签名文件上传/下载、进程执行
- ✅ 快照模式：快照构建成功（active），沙箱从快照 10s 秒开，MinerU 3.4.4 + 2.5GB 模型自带
- ✅ MinerU 3.4.4：PDF / DOCX / XLSX → Markdown 提取（中文、表格、OCR 均验证）
- ✅ 全链路：上传 → 云提取 → 回传 → 本地保存/查看
- ⚠️ 默认类沙箱（1G 内存/3G 磁盘）无法运行 MinerU（实测 OOM）→ 必须使用构建/快照沙箱（4G/10G）

## 目录结构

```
server.js                  # Express 服务（API + 静态前端）
lib/daytona.js             # Daytona Cloud API 客户端（含 toolbox 签名文件传输）
lib/extractor.js           # 任务编排（镜像/沙箱就绪 → 上传 → 执行 → 轮询 → 下载）
lib/state.js               # 状态持久化
docker/MinerU.Dockerfile   # MinerU 提取镜像（CPU 版）
public/                    # Web 前端（上传/任务/正文/文件/日志）
scripts/                   # 测试与探测脚本
data/                      # 运行数据（uploads/jobs/state.json）
```

## 成本提示

- 常驻沙箱（2核/4G/10G）按运行时长计费；24h 自动停机、7 天自动销毁可控制成本。
- 首次初始化包含镜像构建 + 模型下载（~2GB），之后任务仅按提取时长计费。
