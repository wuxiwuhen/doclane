# MINERU·PRESS 迁移方案 — GitHub + Vercel + Supabase + Daytona

> 目标：把当前「单机 Express + SQLite + 本地文件」改造为「Vercel 托管前端/API + Supabase 数据/认证/存储 + Daytona 云端计算 + GitHub 协作部署」的可上线产品，并落地合规主线（敏感识别 + 合规报告 + 审计日志）。
> 面向：个人项目上线，供面试官 / 感兴趣的人在线体验。
>
> ⚠️ **2026-08 修订**：语义/向量检索（pgvector / embedding）已下线，检索仅保留关键词（pg_trgm + bigram）；旧 `server.js` + `lib/extractor.js`/`lib/knowledge.js`/`lib/embedding.js` 等一代代码已退役。本文档保留历史设计，标记处作未来升级参考。
>
> 计算形态（2026-08 修订）：**Daytona 按需沙箱 + 一次性任务执行器（drain.js）**，不留常驻 worker。
> 原因：Daytona 按秒计费（vCPU $0.0504/h、内存 $0.0162/GiB/h、存储 $0.000108/GiB/h，前 5GB 存储免费，新户含 $200 算力额度），
> 常驻轮询进程 = 24/7 空转一台 4G 机器（≈$120/月），且 worker 生命周期被沙箱 TTL/自动停机/销毁操作反复打断；
> 按需方案计费 ≈ 提取时长 + 每次任务 ≤60min 尾保，空闲零成本，$200 额度可跑上千次任务。

---

## 1. 目标架构

```
┌─────────────────────────────┐        ┌────────────────────────────┐
│ 浏览器（访客/面试官）          │        │ GitHub                     │
│  静态前端（Vercel 托管）       │        │  源码 + Actions：           │
│  · Supabase Auth 登录        │        │   · push → Vercel 自动部署  │
└────────────┬────────────────┘        │   · supabase db push（可选） │
             │ HTTPS                    └────────────────────────────┘
             ▼
┌──────────────────────────────────────────────┐
│ Vercel（静态站点 + api/* 无服务器函数）          │
│  · 认证网关（Supabase Auth 校验）               │
│  · 任务 / 知识库 / 修正 / 审计 / 合规 API        │
│  · 上传时 ensure：快照 → 沙箱 → 注入 drain.js   │
└──────────────┬───────────────────┬───────────┘
               │                   │
               ▼                   ▼
┌────────────────────────┐   ┌─────────────────────────────┐
│ Supabase               │   │ Daytona 云沙箱（按需创建）     │
│  · Postgres + pgvector │   │  drain.js（一次性执行器）：    │
│    jobs/文档/chunks     │   │   下载输入 → MinerU 提取      │
│  · Auth（邮箱密码）      │   │   → 产物回传 Storage         │
│  · Storage（输入/产物）  │   │   → 入库 + 向量 → 合规扫描    │
│  · RLS 行级安全         │   │   → 写库 → 退出（60min 尾保） │
└────────────────────────┘   └─────────────────────────────┘
```

**职责划分**

| 平台 | 职责 | 不做什么 |
|---|---|---|
| Vercel | 前端托管、轻 API（<10s 的函数）、认证、静态资源、ensure 编排 | 长任务、队列、内存态、大文件中转 |
| Supabase | 用户/角色、任务与知识库数据、向量检索、文件存储、审计 | 计算密集型任务 |
| Daytona | MinerU 提取、合规扫描（drain.js 进程内）、快照/模型常驻 | 面向用户的业务 API、空闲驻留（autoStop 60min 尾保） |
| GitHub | 源码、CI/CD（Vercel 部署） | — |

**核心原则：所有长耗时工作（初始化、提取、扫描）都不在 Vercel 函数里跑，函数只做「提交 + 查状态」；Daytona 只为任务付费，不留常驻进程。**

---

## 2. 现有模块 → 去向

| 现有文件 | 去向 | 说明 |
|---|---|---|
| `lib/daytona.js` | Vercel 函数 + drain.js 共用 | Daytona API 客户端，**几乎不动** |
| `lib/extractor.js` | drain.js 核心 | 保留三模式（快照/build/运行时）；去掉 server 依赖，任务来源为传入的 jobId + Supabase 读写 |
| `lib/state.js` | 拆两半 | drain.js 侧保留沙箱本地 `state.json`（快照/模型就绪标记，每次运行前校验）；全局设置 → Supabase `settings` 表（仅 `init_state` 等少量） |
| `lib/knowledge.js` | Supabase SQL + pgvector | chunk 切分、`toBigrams`、命中高亮逻辑移植；FTS5 → `pg_trgm` + bigram 预处理列 |
| `lib/embedding.js` | drain.js 内保留 | 向量写入 pgvector 列（README 原设计的兑现） |
| `lib/export-pdf.js` | 前端浏览器打印 或 drain.js 内 headless Chrome | Vercel 无持久 Chrome，见决策点 3 |
| `server.js` API | Vercel `api/*` 函数 | 按域拆分：auth / jobs / kb / audit / admin；新增 `ensureSandbox()` |
| `public/` 前端 | Vercel 静态托管 | 渲染逻辑复用，API 换新、加登录态 |
| 内存任务队列 | Supabase `jobs` 表 | **无轮询进程**——每次上传时按需拉起 drain.js 处理 |
| `data/knowledge.db` | Supabase Postgres | 迁移脚本一次性导入（可选） |

---

## 3. Supabase 数据模型

### 表

```
profiles        user_id (→auth.users) PK, role admin|user, display_name, created_at
jobs            id PK, owner_id, original_name, ext, size, status
                (queued|preparing|running|done|error|cancelled),
                input_storage_path, output_dir, main_md_path,
                quality JSONB, corrections JSONB, error, timestamps
documents       id PK, job_id, filename, ext, size, main_md, created_at
chunks          id PK, doc_id FK, seq, content, embedding vector(1536),
                content_bigrams (pg_trgm 索引用)
audit_logs      id PK, user_id, action, target_type, target_id, meta JSONB, created_at
findings        id PK, doc_id FK, job_id, rule, snippet, offset, status
                (open|redacted|ignored), redacted_snippet, created_at
settings        key PK, value JSONB, updated_at   -- 仅 init_state（快照构建中）等少量
```

### 关键点

- **RLS（行级安全）**：登录用户可读自己的 jobs/documents；知识库按「单组织演示」设计为全体登录用户可读；`audit_logs`、`settings`、`findings` 管理动作仅 admin（`profiles.role='admin'`）。
- **关键词检索**：延续现有 `toBigrams` 思路——入库时把段落内容生成 bigram 串存入 `content_bigrams`，用 `pg_trgm` 索引 + 相似度/匹配查询；中文效果与现有 FTS5 方案等价。
- **语义检索**：`embedding vector(1536)` 列 + Supabase 内置 `pgvector` 扩展，`<=>` 距离查询；未配置 embedding key 时跳过向量，仅关键词可用（沿用现降级逻辑）。
- **存储桶**：`inputs`（原文件）、`outputs`（提取产物 + 脱敏副本）。上传走**预签名直传**（见下），函数不中转文件体。
- **审计**：Vercel 函数内统一中间件写入 `audit_logs`（登录/上传/删除/修正/销毁等动作）。

---

## 4. Vercel API 设计

**Vercel 约束**：Hobby 函数体 ≤4.5MB、默认时长 ≤10s → 决定了"文件直传 + 提交即返回 + 前端轮询"的形态。

```
POST /api/auth/signup|login     Supabase Auth（邮箱密码）
GET  /api/jobs                 我的任务列表
POST /api/jobs                 建任务 → 返回预签名上传 URL（直传 Storage）
POST /api/jobs/:id/uploaded    标记已上传 + 触发 ensure（快照→沙箱→drain.js）
GET  /api/jobs/:id             详情（状态/质量/修正）
POST /api/jobs/:id/correction  人工修正（写修正层 + 重入库）
POST /api/jobs/batch-action    批量（删除/重试/取消）
GET  /api/kb/search            关键词(pg_trgm) / 语义(pgvector) / 混合
GET  /api/kb/docs              已入库文档浏览
GET  /api/compliance/report    合规报告（按规则/文档聚合）  [admin 可看全部]
POST /api/admin/init           手动 ensure（等价旧「初始化」按钮；快照构建期前端轮询续拉）
DELETE /api/admin/sandbox      销毁沙箱（有 running 任务时 409 保护）  [admin]
GET  /api/admin/audit          审计日志  [admin]
```

- 上传链路：`POST /api/jobs` 建行 + 生成 Storage 预签名 PUT URL → **浏览器直接 PUT 到 Supabase Storage**（不经过 Vercel）→ `POST uploaded` 触发 ensure。
- ensure（幂等）：`getSandbox` → 沙箱活着则复用；无沙箱 → `listSnapshots`（快照就绪则 `createSandbox` ~10s 秒开，否则提交快照构建并返回 202「首次环境构建中」，前端周期调 `POST /api/admin/init` 续拉）→ 沙箱停止则 `startSandbox` → 注入 drain.js 并 `nohup node drain.js <jobId> &` → **立即返回 202**，前端轮询任务状态。

---

## 5. Daytona 任务执行设计（按需沙箱 + drain.js）

**形态**：不留常驻进程。Vercel 函数在「上传完成」时 ensure（见 §4），沙箱内跑 **drain.js 一次性任务执行器**（每任务一次，处理完即退出）。

```
ensure（Vercel 函数，幂等，<10s）：
  ① 快照不存在（首次）→ 提交快照构建（5-20min，settings.init_state=building），
     任务排队期间前端周期调 /api/admin/init 续拉，快照就绪后自动继续
  ② 快照就绪但无沙箱 → createSandbox（~10s 秒开，模型自带）
  ③ 沙箱停止（autoStop 尾保停机）→ startSandbox
  ④ toolbox 注入 drain.js 单文件包 + exec nohup node drain.js <jobId> & → 返回 202

drain.js（沙箱内一次性进程，复用 lib/extractor.js）：
  a. 下载输入文件（Storage signed GET）
  b. init()（快照/模型一次就绪，state.json 秒级复用）
  c. runJob → MinerU 提取
  d. 上传产物到 outputs（含主 md + 脱敏副本）
  e. 切 chunk + 生成向量（有 key 时）→ 写 documents/chunks
  f. 合规扫描（正则规则）→ 写 findings
  g. 更新 job status=done / error + 写审计
  处理完毕即退出；沙箱 autoStop=60min 兜底回收，相邻任务自动复用（免重复启动）
```

**成本特性（对比常驻 worker）**：
- 计费 ≈ **提取时长 + 每次任务后 ≤60min 尾保**；空闲零成本，不烧 $200 额度养空转机器
- 快照一次性构建后秒开，销毁重建零成本；沙箱 24h 自动停机 / 7 天 TTL 仅作兜底
- 相邻任务（60min 内）自动复用同一沙箱，无冷启动损耗

**代码分发**：drain.js 由 Vercel 函数在上传时注入沙箱——`scripts/build-runner.mjs` 用 esbuild 预构建单文件（内置 supabase-js 等依赖），随 Vercel 部署走同一通道，**代码永远与 API 同版本，无需独立 worker 部署脚本**。

---

## 6. 合规功能线（主线，P0 之后的重点）

| 能力 | 实现 |
|---|---|
| 敏感识别 | drain.js 在提取产物（MD）上跑规则扫描：身份证、手机号、银行卡、邮箱、金额/日期（正则 + 简单启发式） |
| 详情标红 | 前端渲染正文时按 findings 的 offset/snippet 高亮命中 |
| 一键脱敏 | 生成 `*.redacted.md`（命中处替换为 ██）+ 脱敏版 PDF 导出，存入 outputs 桶 |
| 合规报告页 | 聚合：每类信息出现次数、涉及文档、处理状态（open/redacted/ignored），按文档/规则过滤；可导出 |
| 审计联动 | 修正/忽略/脱敏动作全部写 audit_logs（谁、何时、对哪个文档） |

---

## 7. 分阶段实施

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1 地基** | 仓库重组（`web/ api/ runner/ supabase/migrations/`）；Supabase 建库（表 + RLS + 桶 + pgvector/pg_trgm）；Auth 注册/登录；Vercel 部署骨架（静态页 + 一个 hello 函数） | 访问 Vercel 域名能注册登录，RLS 生效（无 token 读不到数据） |
| **P2 API 迁移** | server.js 按域拆到 `api/*`；任务 CRUD + 预签名上传；知识库检索（pg_trgm + pgvector）；修正接口；前端接新 API + 登录态 | 老功能在 Vercel 上全通（未接 Daytona 也可测到 queued 状态） |
| **P3 任务执行（按需沙箱）** | drain.js 一次性执行器；ensure 幂等（快照→沙箱→注入启动）；产物回传 + 入库向量；autoStop 尾保与复用；`build-runner.mjs` | 上传 PDF → 云提取 → 产物入库 → 可检索，全链路通（含首次快照构建流程） |
| **P4 合规线** | 扫描规则 + findings + 脱敏副本 + 详情标红 + 合规报告页 | 上传含身份证/银行卡样例 → 报告页出数据 + 脱敏版可下载 |
| **P5 上线** | 审计页；示例数据包 + 一键体验；README 重写（架构图/体验链接/成本）；Actions（迁移 + build:runner）；旧 server.js 退役；演示视频 | 陌生人访问 → 注册 → 上传样例 → 看到提取 + 合规报告，全程无翻车 |

---

## 8. 关键决策点（默认推荐）

1. **前端框架**：保留 vanilla 静态前端（快、稳、现有 UI 已精致）。Next.js 作为后续可选迁移，迁移收益低、工作量高。→ 先不动
2. **单文件上限**：免费层 ~40MB/文件（放弃原 300MB ZIP 大文件场景，README 说明）。→ 接受
3. **PDF 导出**：改前端浏览器打印（`window.print` + 打印样式），零依赖零成本；drain.js 内 headless Chrome 为备选。→ 前端打印
4. **语义检索**：保留可选（需 embedding API key，drain.js/函数内调用）；不配则关键词可用。→ 保留可选
5. **任务反馈**：202 + 轮询，不做实时推送（Vercel 10s 限制下最稳）。→ 轮询
6. **沙箱策略**：**按需沙箱 + drain.js 一次性执行器**（每次任务拉起，autoStop 60min 尾保复用）；不做常驻 worker（24/7 空转计费 + 生命周期冲突）。→ 按需

---

## 9. 成本与免费层约束

| 平台 | 约束 | 影响 |
|---|---|---|
| Vercel Hobby | 免费；函数体 ≤4.5MB、时长 ≤10s | 决定"直传 + 202 + 轮询"形态；演示流量足够 |
| Supabase Free | 500MB DB / 1GB Storage / 50MB 文件上限；**7 天不活跃暂停** | 演示数据够用；上线演示前需唤醒 |
| Daytona | 按秒计费：vCPU $0.0504/h、内存 $0.0162/GiB/h、存储 $0.000108/GiB/h（前 5GB 免费）；新户含 $200 算力额度 | **按需沙箱**：计费 ≈ 提取时长 + ≤60min 尾保，空闲零成本；快照一次性构建后秒开。2核/4G 沙箱单任务 ≈ $0.02-0.18，$200 额度可跑上千次 |

---

## 10. Roadmap（明确不做，写进 README）

- 字段级台账抽取（发票/合同结构化）——候选迭代
- RAG 问答——需持续 LLM 成本，缓做
- 文档自动分类/标签——后续
- 生命周期/到期提醒——后续

> 聚焦原则：**把「治理」这条线做真、把产品外壳做完整**——底座（认证/审计/部署）完整，功能线（合规）克制。
