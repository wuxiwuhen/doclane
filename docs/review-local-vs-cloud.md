# Review：本地模式 vs 云端模式的逻辑共用与重构

> 归档日期：2026-08（随重构完成落盘）
> 背景：项目同时支持「本地模式」（`server-local.js`，数据在本地 SQLite + `data/`，算力走 Daytona）
> 与「云端模式」（Vercel `api/*`，数据在 Supabase，算力走 Daytona）。本文回答：两种模式哪些逻辑该共用、
> 哪些重复了，以及如何把核心逻辑收敛成一份。

---

## 1. 结论

- **分层骨架是对的**：路由、数据门面、认证、前端、Daytona 客户端、沙箱执行器源码都是两模式共用一份，**保持不动**。
- **真正的重复集中在「任务执行流水线」**：云端在 `runner/drain.py`（Python）里跑完整条链，本地在 `api/_lib/ensure.js`
  （Node）里重写了一遍，切段/bigram/状态机/释放跨两种语言各有一份，正在漂移。
- 语义/向量检索（embedding/pgvector）**整体下线**，只保留关键词检索；混合/语义留「未来升级」提示。

重构后，核心逻辑（提取 → 切段 → bigram → 入库 → 状态流转 → 用完即毁）**只有一份实现，位于 `runner/drain.py`**，
两种模式的差异被压缩到「数据持久化目标」这一层。

---

## 2. 已经共用的部分（做得对，保留）

| 层 | 文件 | 共用方式 |
|---|---|---|
| 路由分发 | `api/entry.js` | 本地（`server-local.js`）与 Vercel 挂同一 handler，28 个 `routes/*` 零 `DATA_BACKEND` 分支 |
| 数据门面 | `api/_lib/store.js` | `store-local.js`（SQLite+文件）与 `supabase.js`（REST）暴露同一接口：`db.select/insert/update/remove/rpc`、`storage.createSignedUploadUrl/read/signUrl/removeByPrefix`、`signedUrl`、`configured`；local 端用 PostgREST 查询子集解析器模拟了嵌套 join 与 count |
| 认证 | `api/_lib/auth.js` | 共用，local 分支只注入单用户身份（`LOCAL_USER`） |
| 前端 | `public/app.js` | 单份代码 + `CFG.LOCAL_MODE` 标志（免登录/登录两条启动路径） |
| Daytona 客户端 | `lib/daytona.js` | 快照/沙箱/toolbox 签名传输，两模式同一份 |
| 沙箱执行器源码 | `runner/drain.py` → `api/_lib/drain_source.js` | `scripts/sync-drain.mjs` 内联为字符串模块，两模式注入同一份 |

原则：**路由层只认统一门面，模式差异收敛到 store/auth 两个点。**

---

## 3. 重构前的重复点（已修复）

### 3.1 任务执行流水线双实现（最关键）

- 云端：`drain.py main()` 在沙箱内跑完一整条链（下载输入 → MinerU → 上传产物 → 切段+bigram → 写库 → 置状态 → 释放）。
- 本地：`ensureLocal()` 在 Node 进程内重排了同一条链，`drain.py --local` 只做 MinerU + manifest，其余（切段/bigram/写库/状态/释放）由 JS 重写。

结果：改切分规则、改日志、改状态语义都要双改，且已开始漂移（日志文案、超时逻辑不一致）。

**修复**：`drain.py` 新增 `collect_outputs()` 作为「manifest + 主 md + chunks(bigram)」的唯一实现，云端与本地 `--local` 都调用它；本地 `--local` 产出 `ingest.json`，`ensureLocal()` 瘦身为纯适配器（上传 → 启动 → 轮询 → 落盘）。

### 3.2 文本算法多份实现

| 算法 | 重构前 | 现状 |
|---|---|---|
| 中文 bigram 切分 | `lib/knowledge.js`、`api/_lib/text.js`、`drain.py` 三份 | 入库以 `drain.py` 为唯一权威；`text.js` 仅保留检索侧 `toBigrams`（查询词）+ `highlightSnippet` |
| 命中高亮 | `lib/knowledge.js`、`api/_lib/text.js` 两份（旧版不转义 HTML，已分叉） | 仅 `text.js` 一份（含转义） |
| 段落切分 `\n{2,}` | `knowledge.js`、`ensure.js`、`drain.py` 三份 | 仅 `drain.py` 的 `chunk_md` 一份 |

### 3.3 沙箱编排双实现

`api/_lib/ensure.js`（生效）与 `lib/extractor.js`（一代遗留）各有一份快照 Dockerfile + 沙箱资源常量。已删除 `lib/extractor.js`，资源/名称常量统一在 `ensure.js`。

### 3.4 用完即毁（release）双实现

`routes/sandbox-release.js`（云端回调）与 `ensureLocal` 内联逻辑语义一致、代码两份（且本地只查 `queued/uploaded`、云端查全 4 态，存在漂移）。已统一为 `ensure.js` 导出的 `releaseIfIdle(ownerId, currentJobId)`，两处共用。

### 3.5 一代遗留代码

`server.js` + `lib/extractor.js` + `lib/knowledge.js` + `lib/state.js` + `lib/filestore/` + `lib/export-pdf.js` + `lib/embedding.js`
为更早一代整机架构（进程内 Express + SQLite FTS5），仅 `server.js` 自引用。已全部删除，`package.json` 入口改 `server-local.js`。

---

## 4. embedding / 语义检索下线

现状：仅**关键词检索**（中文 bigram + `pg_trgm` / 本地 SQLite `LIKE`）。语义/混合检索留「未来升级」提示。

已删除/修改：

- `lib/embedding.js`（整文件删除）。
- `runner/drain.py`：删除 `EMBED_BASE/EMBED_KEY/EMBED_MODEL` 死变量。
- `api/_lib/ensure.js`：删除 `startDrain` 的 `EMBEDDING_*` env 注入。
- `routes/search.js`：`mode=semantic/hybrid` 一律按关键词处理，返回 `upgrade` 提示语。
- 前端 `public/app.html`/`app.js`/`styles.css`：去掉混合/语义按钮，改为静态提示「关键词检索 · 语义/混合即将上线」。
- `supabase/migrations/0001_init.sql`：去掉 `vector` 扩展 / `embedding` 列 / hnsw 索引；新增 `0005_drop_embedding.sql` 供已上线库降级。
- `.env`/`.env.example`：移除 `EMBEDDING_*`、`ADMIN_EMAILS`、`TTL_MINUTES`、`WARM_UP` 等死变量。

**未来升级路径**：在 `drain.py` 的 `collect_outputs()` 里补向量生成 + 给云端 `chunks` 表/本地 `chunks` 表加 `embedding` 列即可，切段/bigram 仍共用同一份，不会再出现多份实现。

---

## 5. 重构后的目录职责

| 模块 | 职责 |
|---|---|
| `api/entry.js` + `routes/*` | 单一入口 + 业务路由（两模式共用，零分支） |
| `api/_lib/store.js` / `store-local.js` / `supabase.js` | 数据后端门面（唯一模式分叉点） |
| `api/_lib/ensure.js` | 沙箱编排 + `releaseIfIdle` 共用（本地编排瘦身为适配器） |
| `runner/drain.py` | **唯一流水线**：提取 → collect_outputs（切段/bigram）→ 持久化（云端直写 Supabase / 本地写 ingest.json） |
| `api/_lib/text.js` | 检索侧查询词 bigram + 命中高亮 |
| `lib/daytona.js` | Daytona 客户端（唯一 lib） |

---

## 6. 自检记录

- `node --check` 全量活跃 JS 通过。
- `python3 ast.parse runner/drain.py` 通过。
- 本地/云两种 `DATA_BACKEND` 导入冒烟通过（`api/entry.js` 全路由正常加载）。
- `npm run sync:drain` 回归：`drain_source.js` 再生成，无 `EMBED` 残留。
- 活跃代码 grep：无 `embedding` / `pgvector` / `vector(` 残留（仅剩 `semanticEnabled:false` 与「未来升级」提示语）。

---

## 7. 遗留说明（附严重度评估）

| 项 | 严重度 | 状态 | 说明 |
|---|---|---|---|
| 云端 `startDrain` 注入路径 `/root/drain.py` | **中-高（疑似真 bug）** | ✅ 已修复 | 与本地踩过的坑冲突（沙箱用户非 root，`/root` 无写权限，见 commit 9bfca9b）；且云端后台启动用旧写法 `setsid nohup … &`，未用本地修复过的 `( … & )` 子 shell（规避 30s exec 硬上限，见 commit 2d3f9f3）。两处已统一为 `/tmp/doclane-<jobId>` + 子 shell 写法。 |
| 本地 `/uploaded` 请求内同步跑完整流水线 | 低-中 | 待办 | 功能可用（前端不等待该响应、独立轮询）；真正短板是**任务生命周期与 Node 进程绑定**——本地 server 重启会让在途任务卡在 `running`（云端 drain.py 在沙箱内独立存活，不受函数重启影响）。可后续改为本地进程内后台队列/detached 子进程。 |
| 依赖瘦身（移除 multer/puppeteer-core/katex/marked） | 极低 | ✅ 已完成 | multer/puppeteer-core 仅被已删的 server.js/export-pdf.js 引用；katex/marked 由 `public/vendor/` 静态文件提供（不依赖 npm）；保留 dotenv+express，lock 已重生成（0 漏洞）。 |

> 结论：三项里只有「注入路径」是真正可能让云端链路失败的，已本次修复；其余两项分别是健壮性优化（低优先级）和无风险的清理。
