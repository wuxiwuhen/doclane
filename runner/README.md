# runner/ — Daytona 沙箱内的一次性任务执行器（drain.js）

> 设计见 `docs/architecture.md` §4.2 / `docs/migration-plan.md` §5。

**形态**：不留常驻进程。Vercel 函数在「上传完成」时 ensure（复用/新建沙箱），注入本目录预构建的
drain.js 单文件包并 `nohup node drain.js <jobId> &`，处理完即退出，沙箱 autoStop(60min) 尾保回收。

**执行流程**（每任务一次）：
1. 下载输入文件（Supabase Storage signed GET）
2. `lib/extractor.js` init()（快照/模型一次就绪，state.json 秒级复用）
3. runJob → MinerU 提取
4. 上传产物到 outputs 桶（含主 md + 脱敏副本）
5. 切 chunk + 生成向量（有 key 时）→ 写 documents/chunks
6. 合规扫描（正则规则）→ 写 findings
7. 更新 job status=done/error + 写审计

**构建**：`scripts/build-runner.mjs`（esbuild 打包单文件，内置 supabase-js 等依赖），
随 Vercel 部署走同一通道，由函数注入沙箱——代码永远与 API 同版本。
