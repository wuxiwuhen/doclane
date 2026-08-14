// lib/extractor.js — 任务编排：确保镜像/沙箱就绪 → 上传 → 执行 MinerU → 轮询 → 下载产物
//
// 三路径设计（按优先级自动选择，模式持久化在 state.json）：
//  A. buildInfo 模式（默认，当前 API key 即可用）：
//     沙箱创建时用 docker/MinerU.Dockerfile 构建镜像（cpu2/mem4/disk10 等资源随沙箱指定），
//     MinerU 随镜像预装，模型首次运行时下载。构建一次后沙箱常驻复用。
//  B. 快照模式（API key 有 write:snapshots 权限时可用）：
//     把同一 Dockerfile 构建成可复用快照，沙箱从快照秒开（适合频繁销毁重建）。
//  C. 运行时安装模式（buildInfo 也不可用时的最后兜底）：
//     默认小快照 + 沙箱内 pip 安装；受 1G 内存/3G 磁盘限制，大型文档会被 OOM。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DaytonaClient, DaytonaError, sleep } from './daytona.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINERU_DOCKERFILE = readFileSync(path.join(__dirname, '..', 'docker', 'MinerU.Dockerfile'), 'utf8');
// 快照模式可选的"模型烘焙"版 Dockerfile：构建时就把 pipeline 模型下载进镜像层，
// 之后每次从快照创建沙箱都自带完整 MinerU + 模型（秒开即用，销毁重建无成本）。
// 代价：首次快照构建多花 5-10 分钟（下载 ~2GB 模型）。
const MINERU_DOCKERFILE_BAKED = MINERU_DOCKERFILE + `
# 烘焙 pipeline 模型到镜像层（仅快照模式 + BAKE_MODELS=true 时使用）
RUN mineru-models-download -s huggingface -m pipeline
`;
const DEFAULT_SNAPSHOT = process.env.DEFAULT_SNAPSHOT || 'daytonaio/sandbox:0.8.0';

const CFG = {
  region: process.env.REGION || 'us',
  cpu: Number(process.env.SANDBOX_CPU || 2),
  memory: Number(process.env.SANDBOX_MEMORY_GB || 4),
  disk: Number(process.env.SANDBOX_DISK_GB || 10),
  autoStopMinutes: Number(process.env.AUTO_STOP_MINUTES || 1440), // 24h 无活动自动停机（磁盘保留）
  ttlMinutes: Number(process.env.TTL_MINUTES || 10080),           // 7 天寿命上限
  warmUp: (process.env.WARM_UP || 'true') !== 'false',
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MIN || 30) * 60 * 1000,
  pollIntervalMs: 10000,
  buildMode: process.env.BUILD_MODE || 'auto', // auto | build | snapshot | runtime
  bakeModels: (process.env.BAKE_MODELS || 'true') === 'true', // 快照模式是否烘焙模型进镜像
  snapshotClass: process.env.SNAPSHOT_CLASS || 'container',    // 快照沙箱类（可用类以组织为准）
};

export class Extractor {
  constructor({ stateStore, dataDir, client, snapshotName, sandboxName }) {
    this.stateStore = stateStore;
    this.dataDir = dataDir;
    this.client = client || new DaytonaClient();
    this.snapshotName = snapshotName;
    this.sandboxName = sandboxName;
    this._ready = null;
  }

  // ---------- 状态查询 ----------
  async getStatus(onLog) {
    const st = this.stateStore.get();
    const out = {
      mode: CFG.buildMode !== 'auto' ? CFG.buildMode : st.buildMode || 'snapshot', // env 显式配置优先
      snapshot: null, sandbox: null,
      workDir: st.workDir || null,
      mineru: st.mineruBin ? 'installed' : null,
      warmedUp: !!st.warmedUp,
    };
    try {
      if (st.snapshotName) {
        const snaps = await this.client.listSnapshots();
        const hit = snaps.find((s) => s.id === st.snapshotId || s.name === st.snapshotName);
        if (hit) out.snapshot = { id: hit.id, name: hit.name, state: hit.state || hit.status || 'unknown' };
        else out.snapshot = { name: st.snapshotName, state: 'missing' };
      }
    } catch (e) { out.snapshot = { error: e.message }; }
    try {
      if (st.sandboxName) {
        const sb = await this.client.getSandbox(st.sandboxName);
        out.sandbox = { id: sb.id, name: sb.name, state: sb.state };
      }
    } catch (e) { out.sandbox = { name: st.sandboxName, state: 'missing' }; }
    return out;
  }

  async init(onLog = () => {}) {
    if (this._ready) return this._ready;
    const st = this.stateStore.get();
    const mode = this._resolveMode();
    const sb = await this._ensureSandbox(mode, onLog);
    const toolbox = await this.client.toolbox(sb);
    const workDir = await toolbox.workDir();
    onLog(`沙箱就绪（${sb.id}，${workDir}，${sb.cpu}核/${sb.memory}G/${sb.disk}G）`);
    await toolbox.exec(`mkdir -p ${workDir}/jobs`, {}, 15);
    st.workDir = workDir;
    await this._ensureMineru(toolbox, workDir, onLog);
    if (CFG.warmUp && !st.warmedUp) {
      await this._warmUp(toolbox, workDir, onLog);
    }
    this._ready = { sandbox: sb, toolbox, workDir };
    return this._ready;
  }

  async runJob(job, onLog = () => {}) {
    const t0 = Date.now();
    try {
      const { toolbox, workDir } = await this.init(onLog);
      const st = this.stateStore.get();
      const mineruBin = st.mineruBin || 'mineru';
      const safeExt = path.extname(job.originalName).toLowerCase() || '.bin';
      const jobDir = `${workDir}/jobs/${job.id}`;
      const remoteInput = `${jobDir}/input${safeExt}`;
      const remoteOut = `${jobDir}/out`;
      const remoteLog = `${jobDir}/run.log`;

      onLog('在沙箱内创建任务目录…');
      await toolbox.exec(`mkdir -p ${remoteOut}`, {}, 15);

      onLog(`上传文件 ${job.originalName}（${(job.size / 1024 / 1024).toFixed(1)} MB）…`);
      const buf = await fsp.readFile(job.inputPath);
      await toolbox.uploadFile(remoteInput, buf, `input${safeExt}`);

      const flags = this._mineruFlags();
      // 用脚本文件方式启动（内联 bash -c 嵌套引号经 toolbox exec 会挂起）
      // 模型源智能判断：镜像已烘焙本地模型 → local；否则 huggingface 下载
      const runSh = `#!/bin/bash
if [ -d ~/.cache/huggingface/hub/models--opendatalab--PDF-Extract-Kit-1.0 ]; then export MINERU_MODEL_SOURCE=local; else export MINERU_MODEL_SOURCE=huggingface; fi
cd ${jobDir}
${mineruBin} -p "./input${safeExt}" -o "./out" ${flags} > run.log 2>&1
echo "__MINERU_DONE:$?" >> run.log
`;
      await toolbox.uploadFile(`${jobDir}/run.sh`, Buffer.from(runSh), 'run.sh');
      onLog(`启动提取：${mineruBin} -p input${safeExt} -o out ${flags}`);
      const started = await toolbox.exec(`setsid nohup bash ${jobDir}/run.sh >/dev/null 2>&1 < /dev/null & echo STARTED`, {}, 15);
      if (!/STARTED/.test(started.result || '')) throw new Error('无法在沙箱中启动 mineru 后台任务');

      const deadline = Date.now() + (job.timeoutMs || CFG.jobTimeoutMs);
      let lastLog = '';
      while (Date.now() < deadline) {
        await sleep(CFG.pollIntervalMs);
        const tail = await toolbox.exec(`tail -c 4000 ${remoteLog} 2>/dev/null; echo; ls ${remoteOut} 2>/dev/null | head -5`, {}, 20);
        const text = (tail.result || '').trim();
        if (text !== lastLog) { lastLog = text; onLog(text.split('\n').slice(-3).join('\n')); }
        const m = text.match(/__MINERU_DONE:(\d+)/);
        if (m) {
          if (m[1] !== '0') throw new Error(`MinerU 提取失败（exit ${m[1]}）：\n${text.slice(-1500)}`);
          break;
        }
      }
      if (!/__MINERU_DONE/.test(lastLog)) throw new Error('提取超时');

      onLog('提取完成，收集产物…');
      const find = await toolbox.exec(`find ${remoteOut} -type f | sort`, {}, 20);
      const files = (find.result || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!files.length) throw new Error('未找到任何输出文件');

      const localOut = path.join(this.dataDir, 'jobs', job.id, 'output');
      await fsp.mkdir(localOut, { recursive: true });
      const saved = [];
      for (const f of files) {
        const rel = path.relative(remoteOut, f);
        const data = await toolbox.downloadFile(f);
        const target = path.join(localOut, rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data);
        saved.push({ rel, size: data.length, isMd: rel.toLowerCase().endsWith('.md') });
      }
      try {
        const logData = await toolbox.downloadFile(remoteLog);
        await fsp.writeFile(path.join(this.dataDir, 'jobs', job.id, 'run.log'), logData);
      } catch { /* 忽略 */ }

      saved.sort((a, b) => Number(b.isMd) - Number(a.isMd) || a.rel.localeCompare(b.rel));
      return {
        files: saved,
        mainMd: saved.find((f) => f.isMd)?.rel || null,
        durationMs: Date.now() - t0,
      };
    } finally {
      this._ready = null; // 下次任务重新校验沙箱状态
    }
  }

  async destroySandbox(onLog = () => {}) {
    const st = this.stateStore.get();
    if (st.sandboxName) {
      onLog(`销毁沙箱 ${st.sandboxName}…`);
      try { await this.client.deleteSandbox(st.sandboxName); } catch (e) { onLog(`销毁失败: ${e.message}`); }
    }
    st.sandboxId = undefined; st.sandboxName = undefined; st.workDir = undefined;
    st.mineruBin = undefined; st.warmedUp = undefined; st.cliHelp = undefined;
    this.stateStore.save();
    this._ready = null;
  }

  // ---------- 模式解析 ----------
  _resolveMode() {
    const st = this.stateStore.get();
    if (CFG.buildMode !== 'auto') return CFG.buildMode;
    if (st.buildMode) return st.buildMode;
    return 'snapshot'; // 默认快照模式（Full Access/快照权限 key）；无权限时自动降级 build → runtime
  }

  _setMode(mode) {
    const st = this.stateStore.get();
    st.buildMode = mode;
    this.stateStore.save();
  }

  // ---------- 快照（模式 B 用） ----------
  async _ensureSnapshot(onLog) {
    const st = this.stateStore.get();
    if (st.snapshotName) {
      try {
        const snaps = await this.client.listSnapshots();
        const hit = snaps.find((s) => s.id === st.snapshotId || s.name === st.snapshotName);
        if (hit) {
          onLog(`复用已有快照 ${hit.name}（${hit.id}）`);
          return { id: hit.id, name: hit.name };
        }
      } catch (e) { onLog(`查询快照失败: ${e.message}，将重新构建`); }
    }
    onLog(`构建 MinerU 快照（${CFG.cpu}核/${CFG.memory}G/${CFG.disk}G${CFG.bakeModels ? '，含模型烘焙' : ''}，首次约需 5-20 分钟）…`);
    try {
      const created = await this.client.createSnapshot({
        name: this.snapshotName,
        // buildInfo.dockerfileContent 自带 FROM 基础镜像，不可与 imageName 同时指定
        buildInfo: { dockerfileContent: CFG.bakeModels ? MINERU_DOCKERFILE_BAKED : MINERU_DOCKERFILE },
        cpu: CFG.cpu, memory: CFG.memory, disk: CFG.disk,
        regionId: CFG.region,
        sandboxClass: CFG.snapshotClass,
      });
      const id = created.id || created.name;
      st.snapshotId = id; st.snapshotName = this.snapshotName;
      this.stateStore.save();
      await this._pollSnapshot(id, onLog);
      return { id, name: this.snapshotName };
    } catch (e) {
      if (e instanceof DaytonaError && e.status === 403) {
        onLog(`⚠ API key 无快照构建权限（403），快照模式不可用`);
        return null;
      }
      throw e;
    }
  }

  async _pollSnapshot(id, onLog) {
    const bad = new Set(['error', 'build_failed', 'failed', 'destroyed']);
    const done = new Set(['ready', 'active', 'available', 'completed', 'built', 'ok']);
    const deadline = Date.now() + 25 * 60 * 1000;
    let last = '';
    while (Date.now() < deadline) {
      const s = await this.client.getSnapshot(id);
      const state = (s.state || s.status || 'unknown').toLowerCase();
      if (state !== last) { last = state; onLog(`快照构建状态: ${state}`); }
      if (done.has(state)) return s;
      if (bad.has(state)) throw new Error(`快照构建失败: ${state} ${s.errorReason || s.error || ''}`);
      await sleep(8000);
    }
    throw new Error('快照构建超时（25 分钟）');
  }

  // ---------- 沙箱 ----------
  async _ensureSandbox(mode, onLog) {
    const st = this.stateStore.get();
    let sb = null;
    const desiredName = st.sandboxName || this.sandboxName;
    if (desiredName) {
      try {
        sb = await this.client.getSandbox(desiredName);
        onLog(`复用沙箱 ${desiredName}（状态 ${sb.state}）`);
        st.sandboxId = sb.id; st.sandboxName = desiredName;
        this.stateStore.save();
      } catch { sb = null; }
    }
    if (!sb) {
      const common = {
        name: this.sandboxName,
        // MinerU 3.4 不支持 MINERU_MODEL_SOURCE=auto，需显式指定（huggingface/modelscope/local）
        env: { MINERU_MODEL_SOURCE: 'huggingface' },
        autoStopInterval: CFG.autoStopMinutes,
        autoDeleteInterval: -1,
        ttlMinutes: CFG.ttlMinutes,
      };
      if (mode === 'build') {
        onLog(`构建 MinerU 镜像并创建沙箱（${CFG.cpu}核/${CFG.memory}G/${CFG.disk}G，首次约需 5-15 分钟）…`);
        try {
          sb = await this.client.createSandbox({
            ...common,
            buildInfo: { dockerfileContent: MINERU_DOCKERFILE },
            cpu: CFG.cpu, memory: CFG.memory, disk: CFG.disk,
          });
        } catch (e) {
          onLog(`⚠ buildInfo 构建模式失败（${e.message.slice(0, 120)}），降级运行时安装模式…`);
          return this._ensureSandbox('runtime', onLog);
        }
      } else if (mode === 'snapshot') {
        const snapshot = await this._ensureSnapshot(onLog);
        if (!snapshot) {
          onLog('⚠ 快照模式不可用（无快照权限），降级 buildInfo 模式…');
          return this._ensureSandbox('build', onLog);
        }
        onLog(`创建沙箱（来自快照 ${snapshot.name}）…`);
        sb = await this.client.createSandbox({ ...common, snapshot: snapshot.name });
      } else {
        onLog(`创建沙箱（默认快照 ${DEFAULT_SNAPSHOT}）…`);
        sb = await this.client.createSandbox({ ...common, snapshot: DEFAULT_SNAPSHOT });
      }
      st.sandboxId = sb.id; st.sandboxName = this.sandboxName;
      this._setMode(mode);
      this.stateStore.save();
    }
    if (!['started', 'running'].includes(sb.state)) {
      if (sb.state === 'stopped' || sb.state === 'paused') {
        onLog('启动沙箱…');
        await this.client.startSandbox(sb.id || sb.name);
      }
      sb = await this.client.waitForSandbox(sb.id || sb.name, {
        onStatus: onLog, timeoutMs: 30 * 60 * 1000,
      });
    }
    return sb;
  }

  // ---------- MinerU 可用性 ----------
  async _ensureMineru(toolbox, workDir, onLog) {
    const st = this.stateStore.get();
    const venvDir = `${workDir}/mineru-venv`;
    if (st.mineruBin) {
      // 校验仍可用
      const chk = await toolbox.exec(`${st.mineruBin} --version 2>&1 | head -1`, {}, 20);
      if ((chk.result || '').includes('mineru')) return;
      st.mineruBin = undefined;
    }
    // 快照镜像自带 mineru 时直接可用
    const which = await toolbox.exec('command -v mineru && mineru --version 2>&1 | head -1 || echo NO_MINERU', {}, 30);
    if (!/NO_MINERU/.test(which.result || '') && (which.result || '').includes('mineru')) {
      st.mineruBin = 'mineru';
      this.stateStore.save();
      onLog(`MinerU 已随镜像就绪: ${which.result.split('\n')[0]}`);
      return;
    }
    // 运行时安装（py3.13 + uv，默认快照自带；CPU 版 torch 以适配小磁盘默认类）
    onLog('沙箱内安装 MinerU（CPU 版，约 3-6 分钟）…');
    const installScript = `
      set -e
      export UV_CACHE_DIR=${workDir}/.uv-cache
      export TMPDIR=${workDir}/tmp
      mkdir -p "$TMPDIR"
      VENV=${venvDir}
      if [ ! -x "$VENV/bin/mineru" ]; then
        uv venv "$VENV" --python 3.13 -q
        # torch+torchvision 都从 CPU 源装，避免默认类沙箱磁盘放不下 CUDA 版，也避免 torch/torchvision 版本不匹配
        uv pip install --python "$VENV/bin/python" --no-cache torch torchvision --index-url https://download.pytorch.org/whl/cpu
        uv pip install --python "$VENV/bin/python" --no-cache 'mineru[core]>=3.4.0'
        uv pip install --python "$VENV/bin/python" --no-cache --reinstall-package torch --reinstall-package torchvision torch torchvision --index-url https://download.pytorch.org/whl/cpu
        rm -rf "$UV_CACHE_DIR"
      fi
      echo "__INSTALL_DONE:$?"
    `;
    // 上传安装脚本再执行（避免内联引号问题）
    await toolbox.uploadFile(`${venvDir}-install.sh`, Buffer.from(installScript), 'install.sh');
    const r = await toolbox.exec(`setsid nohup bash ${venvDir}-install.sh >/dev/null 2>&1 < /dev/null & echo INSTALL_STARTED`, {}, 15);
    if (!/INSTALL_STARTED/.test(r.result || '')) throw new Error('无法启动 MinerU 安装');
    const deadline = Date.now() + 15 * 60 * 1000;
    let last = '';
    while (Date.now() < deadline) {
      await sleep(10000);
      const tail = await toolbox.exec(`tail -c 800 ${venvDir}-install.log 2>/dev/null; echo; test -x ${venvDir}/bin/mineru && echo __INSTALL_DONE:0 || true`, {}, 20);
      const text = (tail.result || '').trim();
      if (text !== last && text) { last = text; onLog(text.split('\n').slice(-2).join('\n')); }
      if (/__INSTALL_DONE:0/.test(text)) { st.mineruBin = `${venvDir}/bin/mineru`; this.stateStore.save(); onLog('MinerU 安装完成'); return; }
    }
    throw new Error('MinerU 安装超时（15 分钟），请查看日志');
  }

  _mineruFlags() {
    // MinerU 3.4：CPU 场景固定 pipeline 后端（避免默认 hybrid 拉取大 VLM 模型）；
    // markdown 为默认输出格式。MINERU_FORMULA=false 可关闭公式识别。
    const flags = ['--backend pipeline'];
    if ((process.env.MINERU_FORMULA || 'true') === 'false') flags.push('--formula false');
    return flags.join(' ');
  }

  async _warmUp(toolbox, workDir, onLog) {
    const st = this.stateStore.get();
    const mineruBin = st.mineruBin || 'mineru';
    onLog('预热：生成测试图片并触发模型下载（首次约 2-6 分钟）…');
    try {
      // 用脚本文件方式生成测试图并启动（避免内联引号经 exec 挂起）
      const warmupPy = [
        'import struct, zlib',
        'def chunk(t,d):',
        '  c=struct.pack(">I",len(d))+t+d',
        '  return c+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)',
        'w=h=1',
        'raw=b"".join(b"\\x00"+b"\\xff\\x00\\x00" for _ in range(w))',
        'png=b"\\x89PNG\\r\\n\\x1a\\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+chunk(b"IDAT",zlib.compress(raw))+chunk(b"IEND",b"")',
        'open("warmup.png","wb").write(png)',
      ].join('\n');
      const warmupSh = `#!/bin/bash
if [ -d ~/.cache/huggingface/hub/models--opendatalab--PDF-Extract-Kit-1.0 ]; then export MINERU_MODEL_SOURCE=local; else export MINERU_MODEL_SOURCE=huggingface; fi
cd ${workDir}
python3 warmup.py
${mineruBin} -p ./warmup.png -o ./warmup-out --backend pipeline > warmup.log 2>&1
echo "__WARMUP_DONE:$?" >> warmup.log
`;
      await toolbox.uploadFile(`${workDir}/warmup.py`, Buffer.from(warmupPy), 'warmup.py');
      await toolbox.uploadFile(`${workDir}/warmup.sh`, Buffer.from(warmupSh), 'warmup.sh');
      const r = await toolbox.exec(`setsid nohup bash ${workDir}/warmup.sh >/dev/null 2>&1 < /dev/null & echo WARMUP_STARTED`, {}, 15);
      if (!/WARMUP_STARTED/.test(r.result || '')) throw new Error('无法启动预热');
      const deadline = Date.now() + 15 * 60 * 1000;
      let last = '';
      while (Date.now() < deadline) {
        await sleep(10000);
        const tail = await toolbox.exec(`tail -c 1500 ${workDir}/warmup.log 2>/dev/null`, {}, 20);
        const text = (tail.result || '').trim();
        if (text !== last && text) { last = text; onLog(text.split('\n').slice(-2).join('\n')); }
        if (/__WARMUP_DONE:0/.test(text)) { st.warmedUp = true; this.stateStore.save(); onLog('预热完成，模型已就绪'); return; }
        if (/__WARMUP_DONE:[1-9]/.test(text)) { onLog(`预热失败（不影响使用，首次任务会再尝试下载）：${text.slice(-300)}`); return; }
      }
      onLog('预热超时（不影响使用）');
    } catch (e) {
      onLog(`预热跳过: ${e.message}`);
    }
  }
}
