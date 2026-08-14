# MINERU·PRESS 技术架构与交互设计

> 技术路线：**GitHub + Vercel + Supabase + Daytona**
> 本文件回答两个问题：①整个系统由哪些组件构成、各自职责；②组件之间的交互逻辑（请求/数据流向）。
>
> 计算形态：**Daytona 按需沙箱 + 一次性任务执行器（drain.js）**，不留常驻 worker——只为任务付钱，空闲零成本（详见 `migration-plan.md` §5）。

---

## 0. 总览（ASCII）

```
 ┌────────────┐  HTTPS   ┌───────────────────────┐         ┌─────────────────────┐
 │  浏览器     │ ───────▶ │ Vercel                │  REST   │ Supabase            │
 │ 静态前端    │ ◀─────── │  · 静态站点            │ ──────▶ │  · Auth（邮箱密码）   │
 │ (vanilla)  │          │  · api/* 轻函数(<10s)  │ ◀────── │  · Postgres+pgvector │
 └─────┬──────┘          │  · 认证网关/审计        │         │  · Storage 桶       │
       │ 预签名直传        └──────────┬────────────┘         └─────────┬───────────┘
       ▼                             │ 上传时 ensure（快照→沙箱→      ▲
 ┌─────────────┐                     │ 注入并启动 drain.js）           │ 读任务/写结果
 │ Supabase    │  ←────────────  Daytona 云沙箱（按需创建，快照秒开）────┘
 │ Storage     │   signed URL       · drain.js：一次性任务执行器
 └─────────────┘                    · 下载输入 → MinerU 提取 → 回传产物
                                    · 入库/向量/合规扫描 → 写库 → 退出
                                    · autoStop 60min 尾保，相邻任务复用
 ┌────────────┐  git push ──▶ Vercel 自动部署（前端 + 函数 + drain.js 包）
 │ GitHub     │
 └────────────┘
```

---

## 1. 组件与职责

| # | 组件 | 职责 | 不做什么 |
|---|------|------|---------|
| 1 | **浏览器（静态前端）** | 渲染页面（工作台/知识库/合规报告）；调用 Supabase Auth 登录；调 Vercel API 读写数据；预签名直传文件到 Storage；轮询任务状态 | 不做任何业务计算；不持有 Daytona/Supabase service key |
| 2 | **Vercel（api/* 函数）** | 认证网关（校验 JWT）；任务/知识库/修正/审计/合规 API；**上传时 ensure**（复用/新建沙箱 + 注入并启动 drain.js）；语义检索时生成查询向量 | 不跑长任务；不中转文件体（≤4.5MB）；不存数据（无状态） |
| 3 | **Supabase** | Auth（用户/会话）；Postgres 数据（jobs/documents/chunks/findings/audit/settings）+ RLS；pgvector 语义检索 + pg_trgm 关键词；Storage（inputs/outputs） | 不做 MinerU 等计算密集型任务 |
| 4 | **Daytona 云沙箱（按需）** | 快照秒开的算力：跑 **drain.js 一次性任务执行器**（下载输入 → MinerU 提取 → 上传产物 → 入库+向量 → 合规扫描）；autoStop 60min 尾保回收 | 无常驻进程；不对外提供业务 API |
| 5 | **GitHub** | 源码；push → Vercel 自动部署（含 drain.js 预构建包）；Actions 可选 Supabase 迁移 | — |

**信任边界**：
- 浏览器只信 Supabase Auth 会话 + Vercel API（Bearer token）
- Vercel 函数持有 `DAYTONA_API_KEY`、Supabase service key（服务端 env，绝不下发浏览器）
- drain.js（沙箱内，由函数注入）持有 Supabase service key + Embedding key，属于可信计算域
- 所有数据访问强制经过 RLS 或函数内角色校验（admin/user）

---

## 2. 架构总图（Mermaid）

```mermaid
graph TB
    subgraph Client["浏览器（访客/面试官）"]
        UI["静态前端（vanilla JS）<br/>工作台 / 知识库 / 合规报告"]
        AUTH["supabase-js（仅登录/注册）"]
    end

    subgraph Vercel["Vercel（无服务器）"]
        API["api/* 函数<br/>认证网关 · 任务 · 知识库 · 合规 · 审计 · 管理"]
        ENSURE["ensureSandbox()<br/>快照→沙箱→注入 drain.js"]
        EMB["查询向量生成<br/>(EMBEDDING_API_KEY)"]
    end

    subgraph Supabase["Supabase"]
        S_AUTH["Auth<br/>邮箱密码会话"]
        PG[("Postgres + pgvector + pg_trgm<br/>profiles/jobs/documents/chunks<br/>findings/audit_logs/settings")]
        ST[("Storage<br/>inputs / outputs")]
        RLS["RLS 行级安全"]
    end

    subgraph Daytona["Daytona 云沙箱（按需创建）"]
        DRAIN["drain.js<br/>一次性任务执行器"]
        EXTRACT["lib/extractor.js<br/>快照秒开 → MinerU 提取"]
        SCAN["合规扫描器<br/>正则规则 → findings/脱敏"]
        EMBED_W["入库向量生成"]
    end

    subgraph GitHub["GitHub"]
        REPO["源码仓库<br/>web/ api/ runner/ supabase/"]
        ACTIONS["Actions：Supabase 迁移 /<br/>build:runner（esbuild 打包）"]
    end

    UI -->|"登录/注册"| AUTH
    AUTH --> S_AUTH
    UI -->|"Bearer JWT · REST"| API
    API -->|"审计写入"| PG
    API -->|"预签名 URL"| ST
    UI -->|"PUT 直传文件"| ST
    API -->|"上传时 ensure"| ENSURE
    ENSURE -->|"getSandbox/createSnapshot/createSandbox"| DRAIN
    API -->|"语义检索取向量"| EMB
    EMB --> PG

    DRAIN -->|"signed GET 下载输入"| ST
    DRAIN --> EXTRACT
    EXTRACT -->|"产物 signed PUT"| ST
    DRAIN -->|"chunk+向量入库"| PG
    DRAIN --> SCAN
    SCAN -->|"findings + 脱敏副本"| PG
    SCAN --> ST
    DRAIN -->|"jobs.status=done + 审计"| PG

    REPO -->|"git push（含 drain.js 预构建包）"| Vercel
    ACTIONS -->|"supabase db push"| Supabase
```

---

## 3. 基础设施交互矩阵

| 发起方 | 接收方 | 协议/方式 | 内容 | 触发时机 |
|---|---|---|---|---|
| 浏览器 | Supabase Auth | HTTPS REST（supabase-js） | 注册/登录/登出/刷新会话 | 用户操作 |
| 浏览器 | Vercel API | HTTPS REST（Bearer JWT） | 任务/检索/合规/审计/管理 | 用户操作 |
| 浏览器 | Supabase Storage | HTTPS PUT（预签名 URL） | 上传原文件（大文件绕过 Vercel） | 上传文件 |
| Vercel 函数 | Supabase | HTTPS REST（service key） | 读写表、建预签名 URL、审计写入 | 各 API 调用 |
| Vercel 函数 | 第三方 Embedding API | HTTPS | 查询文本 → 向量 | 语义/混合检索 |
| Vercel 函数 | Daytona | HTTPS REST（`lib/daytona.js`） | ensure：复用/新建/启动沙箱 | 上传完成时 |
| Vercel 函数 | 沙箱 | toolbox 注入 + exec | 上传 drain.js 单文件包并 `nohup node drain.js <jobId> &` | 上传完成时 |
| drain.js | Supabase | HTTPS REST（service key） | 读任务、写产物/向量/findings/状态、审计 | 每次任务 |
| drain.js | Supabase Storage | HTTPS signed URL | 下载输入、上传产物/脱敏副本 | 任务处理 |
| drain.js | 第三方 Embedding API | HTTPS | 文档 chunk → 向量 | 入库时 |
| drain.js | 沙箱内 MinerU | 本地进程 | `mineru -p input -o out` | 任务处理 |
| GitHub | Vercel | git push | 前端 + 函数 + drain.js 包自动部署 | 每次 push |
| GitHub Actions | Supabase | supabase CLI | 迁移 SQL 应用 | CI（可选） |

---

## 4. 核心时序（Mermaid 时序图）

### 4.1 注册 / 登录

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器
    participant A as Vercel api/*
    participant SA as Supabase Auth
    participant PG as Supabase Postgres

    B->>SA: signUp(email, password)
    SA-->>B: session + user
    SA->>PG: 触发器创建 profiles(role='user'<br/>管理员邮箱→role='admin')
    B->>A: GET /api/jobs（带 Bearer JWT）
    A->>SA: 校验 JWT → user_id/role
    SA-->>A: ok
    A-->>B: 200 数据（或 401）
```

### 4.2 核心链路：上传 → 云提取 → 入库 → 可检索

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器
    participant A as Vercel api/*
    participant ST as Supabase Storage
    participant PG as Supabase Postgres
    participant D as 沙箱内 drain.js（按需）
    participant M as 沙箱内 MinerU

    B->>A: POST /api/jobs (file meta)
    A->>PG: INSERT jobs(status=queued)
    A->>ST: createSignedUploadUrl(inputs/...)
    ST-->>A: uploadUrl
    A-->>B: {job, uploadUrl} (202)
    B->>ST: PUT 文件直传（不经 Vercel）
    B->>A: POST /api/jobs/:id/uploaded
    A->>PG: jobs.status=uploaded
    A->>A: ensureSandbox()：复用/新建沙箱（~10s）
    A->>A: 注入 drain.js + exec nohup node drain.js <jobId> &
    A-->>B: 202，前端开始轮询
    Note over D: 一次性执行（每任务一次，<br/>处理完即退出）
    D->>ST: signed GET 下载输入文件
    D->>M: init()（快照秒开，模型自带）
    D->>M: 启动 mineru 后台任务
    M-->>D: __MINERU_DONE
    D->>ST: 上传产物（md+图片）到 outputs
    D->>D: 切 chunk → 生成向量（有 key 时）
    D->>PG: UPSERT documents/chunks(pgvector)
    D->>D: 合规扫描 → findings + 脱敏副本
    D->>PG: jobs.status=done + 写审计
    Note over D: drain.js 退出；沙箱 autoStop(60min)<br/>尾保回收，相邻任务自动复用
    loop 前端轮询（4s）
        B->>A: GET /api/jobs/:id
        A-->>B: status
    end
    B-->>B: 渲染正文/文件/日志/标红
```

### 4.3 按需拉起：首次初始化与任务执行

```mermaid
sequenceDiagram
    autonumber
    participant A as Vercel api/*
    participant PG as Supabase Postgres
    participant D as Daytona API
    participant R as 沙箱内 drain.js

    Note over A: 每次「上传完成 / 手动初始化」触发 ensure（幂等）
    A->>D: getSandbox(固定名)
    alt 沙箱存在且运行中（上一任务尾保期内）
        A->>A: 直接复用，跳到注入
    else 沙箱不存在
        A->>D: listSnapshots
        alt 快照已就绪
            A->>D: createSandbox(来自快照，~10s 秒开)
        else 首次：无快照
            A->>D: createSnapshot（异步构建 5-20min）
            A->>PG: settings.init_state=building
            A-->>A: 返回 202「首次环境构建中」
            Note over A: 任务排队期间，前端周期调用<br/>POST /api/admin/init 续拉 ensure，<br/>快照就绪后自动创建沙箱并继续
        end
    else 沙箱已停止（autoStop 尾保停机）
        A->>D: startSandbox
    end
    A->>D: toolbox：注入 drain.js + exec nohup node drain.js <jobId> &
    A-->>A: 返回 202，前端轮询任务状态
    Note over R: drain.js 处理单个任务后退出；<br/>autoStop(60min) 兜底回收，相邻任务复用
```

### 4.4 检索（关键词 / 语义 / 混合）

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器
    participant A as Vercel api/*
    participant E as Embedding API
    participant PG as Supabase Postgres

    B->>A: GET /api/kb/search?q=合同金额&mode=hybrid
    A->>A: 校验 JWT
    alt mode 含语义（已配 EMBEDDING_API_KEY）
        A->>E: 查询文本 → 向量
        E-->>A: vector
        A->>PG: pgvector 距离检索（chunks.embedding）
    end
    A->>PG: pg_trgm 关键词检索（content_bigrams）
    A->>A: RRF 融合 + 命中高亮（复用 toBigrams/高亮逻辑）
    A-->>B: hits（片段/文档/评分）
    B->>A: GET /api/jobs/:id（点击直达原文）
```

### 4.5 合规扫描与报告

```mermaid
sequenceDiagram
    autonumber
    participant D as 沙箱内 drain.js
    participant PG as Supabase Postgres
    participant ST as Supabase Storage
    participant B as 浏览器
    participant A as Vercel api/*

    Note over D: 提取完成后（接 4.2 第 20 步）
    D->>D: 规则扫描 MD（身份证/手机/银行卡/邮箱/金额）
    D->>PG: INSERT findings(rule,snippet,offset,status=open)
    D->>D: 生成脱敏副本（命中→██）
    D->>ST: 上传 *.redacted.md
    B->>A: GET /api/compliance/report
    A->>PG: 按 rule/status/文档 聚合
    A-->>B: 报告（数量/分布/处理状态）
    B->>A: POST /api/findings/:id（标记 ignored / 已修正）
    A->>PG: 更新状态 + 写审计
    A-->>B: ok
```

### 4.6 管理动作（admin）

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器
    participant A as Vercel api/*
    participant PG as Supabase Postgres
    participant D as Daytona API

    B->>A: DELETE /api/admin/sandbox（admin）
    A->>A: 校验 role=admin + 无 running 任务（409 保护）
    A->>D: deleteSandbox
    D-->>A: ok
    A->>PG: 清 settings（init_state/sandbox 记录）+ 审计
    A-->>B: ok（前端状态徽章 → 待初始化）
    B->>A: GET /api/admin/audit
    A->>PG: SELECT audit_logs
    A-->>B: 审计列表（谁/何时/做了什么）
```

### 4.7 部署流水线

```mermaid
sequenceDiagram
    autonumber
    participant Dev as 开发者
    participant GH as GitHub
    participant V as Vercel
    participant SU as Supabase

    Dev->>GH: git push（web/ api/ runner/ supabase/）
    GH->>V: 自动部署（静态站点 + api/* 函数）
    V->>V: build:runner（esbuild 打包 drain.js 单文件，随函数一起发布）
    V-->>GH: 部署完成（预览/生产 URL）
    opt 可选 CI
        GH->>SU: supabase db push（迁移 SQL）
    end
    Note over V: drain.js 无需独立部署通道——<br/>由 Vercel 函数在上传时注入沙箱，<br/>代码永远与 API 同版本
```

---

## 5. 密钥与环境变量分布

| 密钥/变量 | 存放位置 | 说明 |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Vercel env + 前端静态 | anon 仅用于 Auth 客户端 |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env + 沙箱创建时注入 env（drain.js 运行时） | 服务端/可信计算域，**绝不下发浏览器** |
| `DAYTONA_API_KEY` / `DAYTONA_API_URL` | **仅 Vercel env** | 沙箱创建/销毁/注入（drain.js 不需要调 Daytona） |
| `EMBEDDING_API_KEY` / `BASE_URL` / `MODEL` | Vercel env + 沙箱 env | 查询向量（函数）+ 入库向量（drain.js） |
| `ADMIN_EMAILS` | Vercel env | 注册时判定 admin 角色 |
| Sandbox 本地 `state.json` | 沙箱内 | 快照/模型就绪标记，drain.js 每次运行前校验，秒级复用 |

---

## 6. 与现有代码的对应关系

| 架构组件 | 复用/改写现有代码 |
|---|---|
| Vercel api/* | 由 `server.js`（763 行）按域拆分，路由与业务逻辑保留；新增 `ensureSandbox()` 帮助函数 |
| Daytona 任务执行 | `lib/extractor.js`（422 行，核心不动）+ `lib/daytona.js`（250 行，不动）+ `lib/embedding.js`（入库向量）+ 新增 `runner/drain.js`（一次性执行器：下载→提取→回传→入库→扫描；esbuild 预构建单文件，由函数注入沙箱） |
| Supabase 数据层 | `lib/knowledge.js` 的 chunk 切分/`toBigrams`/高亮逻辑移植为 SQL + JS；FTS5 → pg_trgm，SQLite 向量 → pgvector |
| 前端 | `public/`（app.js/index.html/styles.css）渲染逻辑基本保留，API 换新 + 登录态 + 合规报告页 |
| PDF 导出 | `lib/export-pdf.js` 改为前端浏览器打印（或 drain.js 内 headless Chrome，备选） |
| 部署 | 新增 `vercel.json`、`supabase/migrations/*.sql`、`scripts/build-runner.mjs`（esbuild 打包 drain.js） |
