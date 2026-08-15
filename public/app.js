/* MINERU·PRESS 前端逻辑 — 双页面（工作台 / 知识库）+ hash 路由 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B';
  const fmtTime = (t) => {
    if (!t) return '';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    jobs: new Map(), selectedId: null, selectedTab: 'md', autoView: null, autoFollow: false,
    filter: 'all', // all | active | done | error | cancelled | trash
    trashJobs: new Map(),
    selectMode: false, selectedIds: new Set(), historyOpen: true, // 历史记录默认展开
    initBusy: false, // 初始化进行中（防止状态轮询中途隐藏按钮）
    initErrShown: false, // 环境初始化错误只提示一次（避免轮询刷屏）
    userRole: 'user', // 当前用户角色（admin 才显示初始化/销毁入口）
    maxUploadMb: 10, // 单文件大小上限（health 接口动态更新）
  };

  /* ---------- 认证（Supabase Auth）+ 带 token 的请求 ---------- */
  const CFG = window.DSH_CONFIG || {};
  const supabase = window.supabase ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
  let session = null;
  function authHeaders() {
    return session && session.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  }
  function apiFetch(url, opts = {}) {
    return fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  }

  /* ---------- 启动：先认证，未登录跳转登录页 ---------- */
  (async function init() {
    if (!supabase) { flashToast('缺少 Supabase 配置'); return; }
    const { data } = await supabase.auth.getSession();
    session = data.session;
    if (!session) { location.replace('/login.html'); return; }
    // 鉴权通过：隐藏启动屏，显示应用
    document.body.classList.remove('boot-pending');
    const bs = document.getElementById('boot-screen');
    if (bs) bs.remove();
    bootApp();
    supabase.auth.onAuthStateChange((_ev, sess) => {
      const hadSession = !!session;
      session = sess;
      // 登出（有会话 → 无会话）时回登录页
      if (hadSession && !sess) { location.replace('/login.html'); }
    });
  })();

  /* ---------- 退出登录 ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    const logout = document.getElementById('btn-logout');
    if (logout) logout.addEventListener('click', async () => {
      try { await supabase.auth.signOut(); } catch { /* ignore */ }
      location.replace('/login.html');
    });
  });

  function bootApp() {
    router();
    refreshStatus();
    setInterval(refreshStatus, 10000);
    loadUserRole();
    refreshAllLists().then(() => {
      const running = [...state.jobs.values()].filter((j) => ['queued', 'uploaded', 'preparing', 'running'].includes(j.status));
      if (running.length) { selectJob(running[0].id); running.forEach((j) => pollJob(j.id)); }
    }).catch(() => {});
    setInterval(() => {
      const busy = [...state.jobs.values()].some((j) => ['queued', 'uploaded', 'preparing', 'running'].includes(j.status));
      if (!busy) return;
      apiFetch('/api/jobs').then((r) => r.json()).then(({ jobs: list }) => {
        let changed = false;
        for (const j of list) {
          if (state.jobs.get(j.id)?.status !== j.status) changed = true;
          state.jobs.set(j.id, j);
        }
        if (changed) { renderJobList(); if (state.selectedId) renderDetail(state.jobs.get(state.selectedId)); }
        // 待解析中的任务：轮询触发任务级 ensure（幂等续拉；沙箱就绪自动启动 drain.py）
        const uploading = list.filter((j) => j.status === 'uploaded');
        if (uploading.length && !state.initBusy) {
          state.initBusy = true;
          Promise.all(uploading.map((j) =>
            apiFetch(`/api/jobs/${j.id}/ensure`, { method: 'POST' }).then((r) => r.json()).catch(() => null)
          )).then((rs) => {
            const bad = rs.find((d) => d && d.ok === false);
            if (bad && !state.initErrShown) {
              state.initErrShown = true;
              flashToast('解析启动失败：' + ((bad.ensure && bad.ensure.error) || bad.error || '未知错误'));
            }
          }).finally(() => { state.initBusy = false; });
        }
        // 自动跟随：批量模式下，右侧详情始终跟随当前解析中的任务（无解析中则跟随队首）
        if (state.autoFollow) {
          const sorted = sortJobs(state.jobs.values());
          const target = sorted.find((j) => j.status === 'running') || sorted.find((j) => j.status === 'queued') || sorted.find((j) => j.status === 'uploaded') || null;
          if (target) { if (target.id !== state.selectedId) selectJob(target.id); }
          else { state.autoFollow = false; flashToast('批量任务全部完成'); }
        }
      }).catch(() => {});
    }, 2500);
  }

  // 当前用户角色：admin 才显示「初始化/销毁沙箱」入口（任务流转走 /jobs/:id/ensure，与角色无关）
  async function loadUserRole() {
    try {
      if (!supabase || !session) return;
      const { data } = await supabase.from('profiles').select('role').eq('user_id', session.user.id).single();
      if (data && data.role) state.userRole = data.role;
    } catch { /* 默认 user */ }
    // 状态栏显示当前角色（用户可确认自己是否为管理员）
    const wrap = document.getElementById('st-role-wrap');
    const el = document.getElementById('st-role');
    if (wrap && el) {
      wrap.hidden = false;
      el.textContent = state.userRole === 'admin' ? 'ADMIN' : 'USER';
      el.style.color = state.userRole === 'admin' ? 'var(--accent-deep)' : '';
    }
    refreshStatus(); // 按角色刷新按钮可见性
  }

  // 流水线排序：解析中 > 准备/排队 > 其他，同级按创建时间倒序
  const STATUS_ORDER = { running: 0, preparing: 1, uploaded: 1, queued: 1, done: 2, cancelled: 3, error: 4 };
  function sortJobs(list) {
    return [...list].sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 5, sb = STATUS_ORDER[b.status] ?? 5;
      if (sa !== sb) return sa - sb;
      return b.createdAt - a.createdAt;
    });
  }

  /* ---------- Markdown 渲染（转义 HTML、相对图片路径重写、LaTeX → KaTeX） ---------- */
  marked.use({
    extensions: [{
      name: 'math',
      level: 'inline',
      start(src) { return src.indexOf('$'); },
      tokenizer(src) {
        const block = src.match(/^\$\$(.+?)\$\$/s);
        if (block) return { type: 'math', raw: block[0], text: block[1], display: true };
        const inline = src.match(/^\$([^$\n]+?)\$/);
        if (inline) return { type: 'math', raw: inline[0], text: inline[1], display: false };
      },
      renderer(token) {
        try { return katex.renderToString(token.text, { displayMode: token.display, throwOnError: false }); }
        catch { return esc(token.raw); }
      },
    }],
  });

  const SAFE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'img', 'a', 'span', 'sub', 'sup', 'code', 'pre', 'hr', 'blockquote', 'div', 'figure', 'figcaption']);

  // 白名单 HTML 消毒：放行表格等安全标签，移除脚本/事件属性，重写相对图片路径
  function sanitizeHtml(html, jobId, baseDir) {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const fix = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType !== 1) continue; // 只处理元素节点
        const tag = child.tagName.toLowerCase();
        if (!SAFE_TAGS.has(tag)) {
          child.replaceWith(doc.createTextNode(child.outerHTML));
          continue;
        }
        for (const attr of [...child.attributes]) {
          const n = attr.name.toLowerCase();
          if (n.startsWith('on')
            || (n === 'href' && !/^(https?:|#|\/)/.test(attr.value))
            || (n === 'src' && !/^(https?:|data:image|\/)/.test(attr.value))) {
            child.removeAttribute(attr.name);
          }
        }
        if (tag === 'img' && child.getAttribute('src')) {
          let src = child.getAttribute('src');
          if (!/^(https?:|data:|\/)/.test(src)) {
            const rel = src.replace(/^\.\//, '');
            const full = baseDir ? `${baseDir}/${rel}` : rel;
            child.setAttribute('src', `/api/jobs/${jobId}/output/${full.split('/').map(encodeURIComponent).join('/')}`);
          }
        }
        fix(child);
      }
    };
    fix(doc.body);
    return doc.body.innerHTML;
  }

  function mdRenderer(jobId, mainMd) {
    // 图片相对路径基于 md 文件所在目录（如 input/auto/images/x.jpg）
    const baseDir = (mainMd || '').split('/').slice(0, -1).join('/');
    const r = new marked.Renderer();
    r.html = (token) => sanitizeHtml(token.text ?? token.raw ?? '', jobId, baseDir);
    const origImage = r.image.bind(r);
    r.image = (tokens) => {
      let src = tokens.href;
      if (src && !/^(https?:|data:|\/)/.test(src)) {
        const rel = src.replace(/^\.\//, '');
        const full = baseDir ? `${baseDir}/${rel}` : rel;
        src = `/api/jobs/${jobId}/output/${full.split('/').map(encodeURIComponent).join('/')}`;
      }
      return origImage({ href: src, title: tokens.title, text: tokens.text });
    };
    return r;
  }

  /* ---------- 路由 ---------- */
  let kbTimer = null;
  function router() {
    const route = location.hash.replace(/^#\/?/, '');
    const r = route === 'kb' ? 'kb' : 'workspace';
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === r));
    $('#page-workspace').hidden = r !== 'workspace';
    $('#page-kb').hidden = r !== 'kb';
    if (r === 'kb') {
      refreshKb();
      if (!kbTimer) kbTimer = setInterval(refreshKb, 10000);
    } else if (kbTimer) { clearInterval(kbTimer); kbTimer = null; }
  }
  window.addEventListener('hashchange', router);

  /* ---------- 上传 ---------- */
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));
  fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });

  /* 剪贴板粘贴上传：截图后 Ctrl/Cmd+V 直接上传图片（无需存文件） */
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const d = new Date();
        const ts = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
        const named = new File([file], `粘贴图片-${ts}.${ext}`, { type: file.type });
        uploadFiles([named]);
        flashToast('已从剪贴板接收图片，开始解析');
        break;
      }
    }
  });

  function uploadFiles(files) {
    const zips = [...files].filter((f) => /\.zip$/i.test(f.name));
    const others = [...files].filter((f) => !/\.zip$/i.test(f.name));
    for (const z of zips) uploadZip(z);
    for (const f of others) uploadOne(f);
  }

  function uploadOne(file) {
    // 上传前大小校验（服务端同样强校验）
    const maxMb = state.maxUploadMb || 10;
    if (file.size > maxMb * 1024 * 1024) {
      flashToast(`文件超过 ${maxMb}MB 上限，无法上传`);
      return;
    }
    const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const card = buildJobCard({ id: tempId, originalName: file.name, size: file.size, status: 'queued', createdAt: Date.now(), logs: [] });
    card.querySelector('.pill').textContent = '上传中…';
    $('#job-list').prepend(card);
    // 1) 创建任务 → 拿预签名上传 URL
    apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size }),
    }).then((r) => r.json()).then(({ job, uploadUrl, error }) => {
      if (!job) throw new Error(error || '创建任务失败');
      // 2) 浏览器直传 Supabase Storage（绕过 Vercel 体积限制）
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          card.querySelector('.job-bar i').style.width = pct + '%';
          card.querySelector('.pill').textContent = '上传 ' + pct + '%';
        }
      };
      xhr.onload = () => {
        const tmpCard = document.querySelector(`.job[data-id="${tempId}"]`);
        if (tmpCard) tmpCard.remove();
        if (xhr.status >= 200 && xhr.status < 300) {
          state.jobs.delete(tempId);
          state.jobs.set(job.id, job);
          renderJobList();
          state.autoView = job.id;
          selectJob(job.id);
          switchTab('log');
          // 3) 标记已上传并触发 ensure（快照→沙箱→drain.py）
          apiFetch(`/api/jobs/${job.id}/uploaded`, { method: 'POST' })
            .then((r) => r.json())
            .then((d) => {
              if (d && d.ok === false) {
                flashToast('解析启动失败：' + (d.ensure?.error || d.error || '未知错误'));
              }
            })
            .catch((e) => flashToast('解析启动失败：' + (e.message || '网络错误')));
          pollJob(job.id);
        } else {
          state.jobs.delete(tempId); renderJobList();
          flashToast('上传失败（' + xhr.status + '）');
        }
      };
      xhr.onerror = () => {
        const tmpCard = document.querySelector(`.job[data-id="${tempId}"]`);
        if (tmpCard) tmpCard.remove();
        state.jobs.delete(tempId); renderJobList();
        flashToast('网络错误');
      };
      xhr.send(file);
    }).catch((e) => {
      const tmpCard = document.querySelector(`.job[data-id="${tempId}"]`);
      if (tmpCard) tmpCard.remove();
      state.jobs.delete(tempId); renderJobList();
      flashToast(e.message || '创建任务失败');
    });
  }

  function uploadZip(file) {
    flashToast('批量 ZIP 暂不支持，请逐个上传文档');
  }

  /* ---------- 任务列表 ---------- */
  function statusText(job) {
    return job.status === 'queued' ? '排队中' : job.status === 'uploaded' ? '待解析' : job.status === 'preparing' ? '准备中' : job.status === 'running' ? '解析中' : job.status === 'done' ? '完成' : job.status === 'error' ? '失败' : job.status === 'cancelled' ? '已取消' : job.status;
  }

  function qualityBadge(job) {
    if (job.status !== 'done' || !job.quality) return '';
    const q = job.quality;
    const remaining = typeof q.remainingLow === 'number' ? q.remainingLow : (q.lowConfidence || []).length;
    if (q.level !== 'ok' && (q.lowConfidence || []).length > 0 && remaining === 0) {
      return `<span class="q-badge q-fixed" title="原始识别存在低置信片段，已全部人工修正">✓ 已复核</span>`;
    }
    if (q.level === 'ok') return '';
    const cls = q.level === 'warn' ? 'q-warn' : 'q-error';
    const label = q.level === 'warn' ? '⚠ 存疑' : '⚠ 异常';
    const suffix = remaining > 0 ? ` ·${remaining}处` : '';
    const title = (q.reasons || []).join('；');
    return `<span class="q-badge ${cls}" title="${esc(title)}">${label}${suffix}</span>`;
  }

  function renderJobActions(card, job) {
    const box = card.querySelector('.job-actions');
    if (!box) return;
    let html = '';
    if (job.deletedAt) {
      html += `<button class="ja" data-act="restore" title="恢复到流水线">↩ 恢复</button>`;
      html += `<button class="ja ja-danger" data-act="purge" title="彻底删除（不可恢复）">🗑 彻底删除</button>`;
      box.innerHTML = html;
      box.querySelectorAll('.ja').forEach((b) => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (b.dataset.act === 'restore') {
            apiFetch(`/api/jobs/${job.id}/restore`, { method: 'POST' }).then((r) => r.json()).then((d) => {
              if (d.job) { flashToast('已恢复'); refreshAllLists(); }
              else flashToast(d.error || '恢复失败');
            }).catch(() => flashToast('恢复失败'));
          } else if (b.dataset.act === 'purge') {
            showConfirm({
              title: '彻底删除',
              message: `将彻底删除「${job.originalName}」及其全部文件，此操作不可恢复。确认？`,
              confirmText: '彻底删除',
              danger: true,
              glyph: '🗑',
            }).then((ok) => {
              if (!ok) return;
              apiFetch(`/api/trash/${job.id}`, { method: 'DELETE' }).then((r) => r.json()).then((d) => {
                if (d.ok) { flashToast('已彻底删除'); refreshAllLists(); }
                else flashToast(d.error || '删除失败');
              }).catch(() => flashToast('删除失败'));
            });
          }
        });
      });
      return;
    }
    if (state.selectMode) { box.innerHTML = ''; return; }
    if (job.status === 'queued' || job.status === 'uploaded') {
      html += `<button class="ja" data-act="cancel" title="取消排队">✕ 取消</button>`;
      html += `<button class="ja ja-danger" data-act="delete" title="删除任务及文件">🗑 删除</button>`;
    } else if (job.status === 'running') {
      html += `<span class="ja ja-disabled" title="解析中不可操作">解析中…</span>`;
    } else if (job.status === 'error' || job.status === 'done' || job.status === 'cancelled') {
      if (job.status === 'error' || job.status === 'done') html += `<button class="ja" data-act="retry" title="重新解析">⟳ 重试</button>`;
      html += `<button class="ja ja-danger" data-act="delete" title="删除任务及文件">🗑 删除</button>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('.ja').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'delete') {
          showConfirm({
            title: '删除任务',
            message: `确认删除「${job.originalName}」？产物文件和知识库记录将一并删除。`,
            confirmText: '删除',
            danger: true,
            glyph: '🗑',
          }).then((ok) => {
            if (!ok) return;
            apiFetch(`/api/jobs/${job.id}`, { method: 'DELETE' }).then((r) => r.json()).then((d) => {
              if (d.ok) { if (state.selectedId === job.id) { state.selectedId = null; $('#detail').hidden = true; $('#detail-empty').hidden = false; } flashToast('已移入回收站'); refreshAllLists(); }
              else flashToast(d.error || '删除失败');
            }).catch(() => flashToast('删除失败'));
          });
        } else if (act === 'retry') {
          apiFetch(`/api/jobs/${job.id}/retry`, { method: 'POST' }).then((r) => r.json()).then((d) => {
            if (d.job) { state.jobs.set(job.id, d.job); renderJobList(); pollJob(job.id); flashToast('已重新入队'); }
            else flashToast(d.error || '重试失败');
          }).catch(() => flashToast('重试失败'));
        } else if (act === 'cancel') {
          apiFetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).then((r) => r.json()).then((d) => {
            if (d.job) { state.jobs.set(job.id, d.job); renderJobList(); flashToast('已取消'); }
            else flashToast(d.error || '取消失败');
          }).catch(() => flashToast('取消失败'));
        }
      });
    });
  }

  function buildJobCard(job) {
    const li = document.createElement('li');
    li.className = 'job' + (state.selectedIds.has(job.id) ? ' sel' : '');
    li.dataset.id = job.id;
    li.dataset.status = job.status;
    li.innerHTML = `
      <div class="job-top">
        <span class="job-check" data-check></span>
        <span class="job-name" title="${esc(job.originalName)}">${esc(job.originalName)}</span>
        <div class="job-top-right">
          ${qualityBadge(job)}
          <span class="pill" data-status="${esc(job.status)}">${esc(statusText(job))}</span>
        </div>
      </div>
      <div class="job-meta">
        <span>${job.id.startsWith('tmp-') || job.id.startsWith('zip-') ? '—' : '№ ' + job.id.slice(0, 8)}</span>
        <span>${fmtSize(job.size)}</span>
        <span>${fmtTime(job.createdAt)}</span>
        ${job.durationMs ? `<span>${(job.durationMs / 1000).toFixed(0)}s</span>` : ''}
      </div>
      <div class="job-bar"><i></i></div>
      <div class="job-actions"></div>`;
    li.addEventListener('click', () => {
      if (state.selectMode) { toggleSelect(job.id); return; }
      state.autoFollow = false;
      selectJob(job.id);
    });
    renderJobActions(li, job);
    return li;
  }

  function getFilteredJobs() {
    if (state.filter === 'trash') {
      return [...state.trashJobs.values()].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    }
    const all = sortJobs(state.jobs.values());
    return state.filter === 'all' ? all : all.filter((j) => {
      if (state.filter === 'active') return ['running', 'queued', 'uploaded'].includes(j.status);
      if (state.filter === 'done') return j.status === 'done';
      if (state.filter === 'error') return j.status === 'error';
      if (state.filter === 'cancelled') return j.status === 'cancelled';
      return true;
    });
  }

  function renderJobList() {
    const list = $('#job-list');
    const all = sortJobs(state.jobs.values());
    $('#queue-count').textContent = all.length + ' 项';
    // 筛选
    const filtered = getFilteredJobs();
    list.innerHTML = '';
    $('#btn-select').hidden = state.filter === 'trash';
    $('#btn-empty-trash').hidden = state.filter !== 'trash';
    $('#batch-bar').hidden = true;
    $('#job-empty').style.display = filtered.length ? 'none' : 'flex';
    if (!filtered.length) return;
    const active = filtered.filter((j) => ['running', 'queued'].includes(j.status));
    const history = filtered.filter((j) => !['running', 'queued'].includes(j.status));
    for (const job of active) list.appendChild(buildJobCard(job));
    if (history.length) {
      if (state.filter === 'all') {
        // 折叠历史组：默认收起，选中历史任务时自动展开
        const open = state.historyOpen || history.some((j) => j.id === state.selectedId);
        const toggle = document.createElement('li');
        toggle.className = 'history-toggle';
        toggle.innerHTML = `<span class="ht-label">历史记录 <span class="ht-count">${history.length}</span></span><span class="ht-arrow">${open ? '▾' : '▸'}</span>`;
        toggle.addEventListener('click', () => { state.historyOpen = !open; renderJobList(); });
        list.appendChild(toggle);
        if (open) for (const job of history) list.appendChild(buildJobCard(job));
      } else {
        for (const job of history) list.appendChild(buildJobCard(job));
      }
    }
    // 选择模式指示
    document.querySelectorAll('.job').forEach((c) => c.classList.toggle('selectable', state.selectMode));
    $('#batch-bar').hidden = !state.selectMode;
    if (state.selectMode) $('#batch-count').textContent = `已选 ${state.selectedIds.size} 项`;
    // 进行中进度条动画
    for (const job of all) {
      if (job.status === 'running') {
        const bar = list.querySelector(`.job[data-id="${job.id}"] .job-bar i`);
        if (bar) animateBar(bar);
      }
    }
  }

  function animateBar(el) {
    let w = 45;
    const iv = setInterval(() => {
      if (!document.body.contains(el)) return clearInterval(iv);
      w = Math.min(92, w + (100 - w) * 0.03 + 0.4);
      el.style.width = w + '%';
    }, 900);
  }

  /* ---------- 详情 ---------- */
  async function selectJob(id) {
    state.selectedId = id;
    renderJobList();
    const job = state.jobs.get(id);
    if (!job) {
      if (state.trashJobs.has(id)) flashToast('回收站中的任务请先「恢复」再查看');
      return;
    }
    const fresh = await apiFetch(`/api/jobs/${id}`).then((r) => r.json()).then((d) => d.job).catch(() => null);
    if (fresh) { state.jobs.set(id, fresh); renderJobList(); }
    renderDetail(state.jobs.get(id) || job);
    if (fresh) pollJob(id);
  }

  function renderDetail(job) {
    $('#detail-empty').hidden = true;
    $('#detail').hidden = false;
    $('#d-name').textContent = job.originalName;
    const pill = $('#d-status');
    pill.dataset.status = job.status;
    pill.textContent = statusText(job);
    const meta = [`№ ${job.id.slice(0, 8)}`, fmtSize(job.size), fmtTime(job.createdAt)];
    if (job.durationMs) meta.push(`耗时 ${(job.durationMs / 1000).toFixed(0)}s`);
    if (job.quality && job.quality.level !== 'ok') {
      const q = job.quality;
      const remaining = typeof q.remainingLow === 'number' ? q.remainingLow : (q.lowConfidence || []).length;
      if ((q.lowConfidence || []).length > 0 && remaining === 0) meta.push('质量: ✓ 已人工复核');
      else meta.push(`质量: ${(q.reasons || []).join('；')}${remaining ? `（剩 ${remaining} 处待核对）` : ''}`);
    }
    if (job.error) meta.push(`ERR: ${job.error}`);
    $('#d-meta').textContent = meta.join(' · ');
    $('#tab-files-count').textContent = (job.files || []).length ? ` ${job.files.length}` : '';

    // 部署版暂不支持服务端 PDF 导出（改用浏览器打印），隐藏按钮
    const dlBtn = $('#btn-download-md');
    dlBtn.hidden = true;

    const mdView = $('#md-view');
    const mdEmpty = $('#md-empty');
    if (job.status === 'done' && job.mainMd) {
      // 拉取"原始提取 + 人工修正"合成后的正文
      apiFetch(`/api/jobs/${job.id}/corrected`)
        .then((r) => r.text())
        .then((text) => {
          marked.use({ renderer: mdRenderer(job.id, job.mainMd) });
          mdView.innerHTML = marked.parse(text);
          markLowConfidence(job);
          mdView.hidden = false;
          mdEmpty.hidden = true;
        })
        .catch(() => { mdView.hidden = true; mdEmpty.hidden = false; mdEmpty.textContent = '正文加载失败'; });
    } else {
      mdView.hidden = true;
      mdEmpty.hidden = job.status !== 'done';
      mdEmpty.innerHTML = `<div class="empty-glyph">¶</div><p>${job.status === 'done' ? '该任务未产出 Markdown 正文' : '解析完成后在此显示正文'}</p>`;
    }

    renderFiles(job);
    renderLog(job);
    switchTab(state.selectedTab);
  }

  function renderFiles(job) {
    const pane = $('#pane-files');
    const files = job.files || [];
    if (!files.length) {
      pane.innerHTML = `<div class="empty-state"><p>${job.status === 'done' ? '无输出文件' : '解析完成后在此列出产物'}</p></div>`;
      return;
    }
    const mds = files.filter((f) => f.isMd);
    const others = files.filter((f) => !f.isMd);
    const thumbs = files.filter((f) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.rel));
    let html = '';
    const group = (title, arr) => {
      if (!arr.length) return '';
      const rows = arr.map((f) => `
        <div class="file-row">
          <span class="file-ico ${f.isMd ? 'md' : /\.(png|jpe?g|gif|webp)$/i.test(f.rel) ? 'img' : ''}">${esc(f.rel.split('.').pop().toUpperCase())}</span>
          <span class="file-name" title="${esc(f.rel)}">${esc(f.rel)}</span>
          <span class="file-size">${fmtSize(f.size)}</span>
          <a class="file-link" href="/api/jobs/${job.id}/output/${f.rel.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">打开 ↗</a>
        </div>`).join('');
      return `<div class="file-group"><div class="file-group-title">${title}</div>${rows}</div>`;
    };
    html += group('MARKDOWN 正文', mds);
    html += group('其他产物', others);
    if (thumbs.length) {
      html += `<div class="file-group"><div class="file-group-title">图片预览</div><div class="file-thumbs">` +
        thumbs.map((f) => {
          const href = `/api/jobs/${job.id}/output/${f.rel.split('/').map(encodeURIComponent).join('/')}`;
          return `<a href="${href}" target="_blank" rel="noopener"><img loading="lazy" src="${href}" alt="${esc(f.rel)}" /><span>${esc(f.rel)}</span></a>`;
        }).join('') + `</div></div>`;
    }
    pane.innerHTML = html;
  }

  async function renderLog(job) {
    const view = $('#log-view');
    try {
      const { logs } = await apiFetch(`/api/jobs/${job.id}/log?lines=400`).then((r) => r.json());
      view.innerHTML = logs.map((l) => {
        const cls = /失败|提取失败/.test(l.msg) ? 'lg-err' : /完成|就绪|入库/.test(l.msg) ? 'lg-ok' : '';
        return `<span class="lg-time">${fmtTime(l.t)}</span>  <span class="${cls}">${esc(l.msg)}</span>`;
      }).join('\n');
      view.scrollTop = view.scrollHeight;
    } catch { /* noop */ }
  }

  async function pollJob(id) {
    const job = state.jobs.get(id);
    if (!job || ['done', 'error'].includes(job.status)) { if (state.selectedId === id) renderLog(job); return; }
    const d = await apiFetch(`/api/jobs/${id}`).then((r) => r.json()).then((x) => x.job).catch(() => null);
    if (!d) return;
    state.jobs.set(id, d);
    renderJobList();
    if (state.selectedId === id) {
      renderDetail(d);
      // 上传后自动看日志的任务完成时，自动切回正文
      if ((d.status === 'done' || d.status === 'error') && state.autoView === id && state.selectedTab === 'log') {
        switchTab('md');
        state.autoView = null;
      }
    }
    if (!['done', 'error'].includes(d.status)) setTimeout(() => pollJob(id), 2200);
  }

  function switchTab(name) {
    state.selectedTab = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['md', 'files', 'log'].forEach((p) => $('#pane-' + p).classList.toggle('active', p === name));
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /* 导出 PDF：点击即下载服务端生成的 PDF（保真渲染，无需打印对话框） */
  $('#btn-download-md').addEventListener('click', (e) => {
    // 保留 <a href> 默认下载行为即可（指向 /api/jobs/:id/export-pdf）
  });

  /* ---------- 知识库 ---------- */
  async function refreshKb() {
    try {
      const { stats, documents } = await apiFetch('/api/kb').then((r) => r.json());
      $('#kb-stat-docs').textContent = stats.documents;
      $('#kb-stat-chunks').textContent = stats.chunks;
      const searching = !!$('#kb-input').value.trim();
      const browse = $('#kb-browse');
      if (documents.length) {
        browse.innerHTML = '<div class="kb-browse-title">已入库文档</div>' +
          documents.map((d) => `
            <div class="kb-doc" data-doc="${esc(d.id)}">
              <span class="file-ico ${d.ext === '.md' ? 'md' : ''}">${esc((d.ext || '.bin').replace('.', '').toUpperCase())}</span>
              <span class="kb-doc-name" title="${esc(d.filename)}">${esc(d.filename)}</span>
              <span class="kb-doc-meta">${fmtSize(d.size)} · ${fmtTime(d.created_at)}</span>
              <button class="ja ja-danger kb-del" data-doc="${esc(d.id)}" title="删除文档">🗑</button>
            </div>`).join('');
        browse.querySelectorAll('.kb-doc').forEach((el) => el.addEventListener('click', () => openDoc(el.dataset.doc)));
        browse.querySelectorAll('.kb-del').forEach((el) => el.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = el.dataset.doc;
          const name = el.closest('.kb-doc').querySelector('.kb-doc-name').textContent;
          showConfirm({
            title: '删除知识库文档',
            message: `确认从知识库删除「${name}」？检索片段和产物文件将一并删除。`,
            confirmText: '删除',
            danger: true,
            glyph: '🗑',
          }).then((ok) => {
            if (!ok) return;
            apiFetch(`/api/kb/${id}`, { method: 'DELETE' }).then((r) => r.json()).then((d) => {
              if (d.ok) { refreshKb(); flashToast('已删除'); }
              else flashToast(d.error || '删除失败');
            }).catch(() => flashToast('删除失败'));
          });
        }));
        $('#kb-empty').hidden = true;
        // 仅在非搜索状态下才显示"已入库文档"列表，避免轮询覆盖搜索结果
        if (!searching) {
          browse.hidden = false;
          $('#kb-results').hidden = true;
        }
      } else {
        browse.innerHTML = '';
        if (!searching) {
          browse.hidden = true;
          $('#kb-empty').hidden = false;
        }
      }
    } catch { /* noop */ }
  }

  let kbMode = 'hybrid'; // hybrid | keyword | semantic
  document.querySelectorAll('.km').forEach((b) => {
    b.addEventListener('click', () => {
      kbMode = b.dataset.mode;
      document.querySelectorAll('.km').forEach((x) => x.classList.toggle('active', x === b));
      doSearch($('#kb-input').value.trim());
    });
  });

  async function doSearch(q) {
    if (!q) {
      $('#kb-results').hidden = true;
      $('#kb-browse').hidden = false;
      return;
    }
    const { total, hits, mode, semanticEnabled, degraded, error } =
      await apiFetch(`/api/search?q=${encodeURIComponent(q)}&mode=${kbMode}`).then((r) => r.json());
    $('#kb-browse').hidden = true;
    const res = $('#kb-results');
    res.hidden = false;
    const modeLabel = { hybrid: '混合', keyword: '关键词', semantic: '语义' }[mode] || mode;
    if (!hits.length) {
      res.innerHTML = `<div class="empty-state"><p>未找到与「${esc(q)}」相关的内容</p>
        ${degraded ? `<p class="empty-sub">${esc(error || '语义检索不可用，请配置 EMBEDDING_API_KEY 后重试')}</p>` : ''}</div>`;
      return;
    }
    const docCount = new Set(hits.map((h) => h.docId)).size;
    const modeNote = degraded
      ? `<span class="kb-mode-note warn">· 语义未启用，当前为关键词结果</span>`
      : mode === 'semantic' && !semanticEnabled ? '' : '';
    res.innerHTML = `<div class="kb-result-head">[${modeLabel}] 命中 ${total} 条，来自 ${docCount} 份文档 ${modeNote}</div>` +
      hits.map((h) => `
        <div class="kb-hit" data-doc="${esc(h.docId)}">
          <div class="kb-hit-top">
            <span class="kb-hit-name">${esc(h.filename)}</span>
            <span class="kb-hit-meta">${fmtTime(h.createdAt)}</span>
          </div>
          <div class="kb-hit-snippet">${h.snippet}</div>
        </div>`).join('');
    res.querySelectorAll('.kb-hit').forEach((el) => el.addEventListener('click', () => openDoc(el.dataset.doc)));
  }

  function openDoc(docId) {
    location.hash = '#/workspace';
    selectJob(docId);
  }

  let kbInputTimer = null;
  $('#kb-input').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    $('#kb-clear').hidden = !q;
    clearTimeout(kbInputTimer);
    kbInputTimer = setTimeout(() => doSearch(q), 300);
  });
  $('#kb-clear').addEventListener('click', () => {
    $('#kb-input').value = '';
    $('#kb-clear').hidden = true;
    doSearch('');
  });

  /* ---------- 低置信度 OCR 片段标记 + 原图区域核对 ---------- */
  // 在正文中找到第 nth 处 content 并包裹为可点击 mark（跳过已标记位置），返回是否成功
  function findAndWrap(view, content, nth, span) {
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let seen = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement && node.parentElement.closest('mark.low-conf')) continue; // 跳过已标记位置
      const text = node.nodeValue || '';
      let from = 0;
      for (;;) {
        const idx = text.indexOf(content, from);
        if (idx < 0) break;
        if (seen === nth) {
          const frag = document.createDocumentFragment();
          frag.appendChild(document.createTextNode(text.slice(0, idx)));
          const mark = document.createElement('mark');
          mark.className = 'low-conf';
          mark.dataset.score = span.score.toFixed(2);
          mark.dataset.bbox = JSON.stringify(span.bbox);
          mark.textContent = content;
          frag.appendChild(mark);
          frag.appendChild(document.createTextNode(text.slice(idx + content.length)));
          node.parentNode.replaceChild(frag, node);
          return true;
        }
        seen++;
        from = idx + content.length;
      }
    }
    return false;
  }

  function markLowConfidence(job) {
    const view = $('#md-view');
    const low = job.quality?.lowConfidence;
    if (!view || !low?.length) return;
    // 一次标记所有存疑位置：同一 content 出现多处时，每处都标（按顺序绑定各自 bbox），
    // 不随人工修正"冒新"，避免"修一个又出来一个"
    const corrected = new Set((job.corrections || []).map((c) => c.original));
    const used = new Map(); // content -> 已标记次数
    for (const span of low) {
      if (!span.content || corrected.has(span.content)) continue;
      const nth = used.get(span.content) || 0;
      if (findAndWrap(view, span.content, nth, span)) used.set(span.content, nth + 1);
    }
    view.querySelectorAll('mark.low-conf').forEach((m) => {
      m.addEventListener('click', () => showBoxPreview(job, m));
    });
  }

  function showBoxPreview(job, markEl) {
    const q = job.quality || {};
    if (q.originType === 'pdf') { flashToast('PDF 文档的区域核对将在后续版本支持'); return; }
    if (!q.pageSize) { flashToast('缺少页面尺寸数据'); return; }
    let bbox;
    try { bbox = JSON.parse(markEl.dataset.bbox); } catch { flashToast('缺少位置数据'); return; }
    const img = new Image();
    img.onload = () => {
      // bbox 是预处理后页面坐标；按原图/页面尺寸比例换算回原始坐标，1:1 原分辨率裁剪（最大清晰度）
      const scaleX = img.naturalWidth / q.pageSize[0];
      const scaleY = img.naturalHeight / q.pageSize[1];
      const [x1, y1, x2, y2] = bbox;
      const sx = Math.round(x1 * scaleX), sy = Math.round(y1 * scaleY);
      const sw = Math.max(1, Math.round((x2 - x1) * scaleX)), sh = Math.max(1, Math.round((y2 - y1) * scaleY));
      const canvas = document.createElement('canvas');
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sw, sh);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      showBoxModal(canvas.toDataURL('image/png'), `识别置信度 ${(parseFloat(markEl.dataset.score) * 100).toFixed(0)}%`, bbox, img.naturalWidth, img.naturalHeight, job, markEl.textContent);
    };
    img.onerror = () => flashToast('原始文件加载失败');
    img.src = `/api/jobs/${job.id}/original`;
  }

  function showBoxModal(dataUrl, scoreLabel, bbox, imgW, imgH, job = null, originalText = '') {
    let mask = document.getElementById('box-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'box-mask';
      mask.className = 'confirm-mask';
      document.body.appendChild(mask);
    }
    const correctBox = job
      ? `<div class="box-correct">
          <label for="box-correct-input" class="box-correct-label">人工修正</label>
          <textarea id="box-correct-input" rows="2" placeholder="识别可能有误，在此输入正确内容…">${esc(originalText)}</textarea>
          <div class="box-correct-actions">
            <button id="box-correct-save" class="btn">保存修正</button>
            <span id="box-correct-msg" class="box-correct-msg"></span>
          </div>
        </div>`
      : '';
    mask.innerHTML = `
      <div class="confirm-box box-preview">
        <div class="confirm-glyph">🔍</div>
        <h3 class="confirm-title">原图区域核对</h3>
        <p class="confirm-msg">${esc(scoreLabel)} · 区域 (${bbox.join(', ')}) · 原图 ${imgW}×${imgH} · 保持原始尺寸</p>
        <div class="box-img-wrap"><img src="${dataUrl}" alt="原图裁剪区域" /></div>
        ${correctBox}
        <div class="confirm-actions">
          <button id="box-close" class="btn btn-ghost">关闭</button>
        </div>
      </div>`;
    mask.hidden = false;
    const close = () => { mask.hidden = true; };
    mask.querySelector('#box-close').onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };

    // 保存修正
    const saveBtn = mask.querySelector('#box-correct-save');
    if (saveBtn && job) {
      saveBtn.onclick = async () => {
        const correct = mask.querySelector('#box-correct-input').value.trim();
        const msg = mask.querySelector('#box-correct-msg');
        if (!correct) { msg.textContent = '请输入正确内容'; return; }
        if (correct === originalText) { msg.textContent = '内容未变化'; return; }
        saveBtn.disabled = true; msg.textContent = '保存中…';
        try {
          const r = await apiFetch(`/api/jobs/${job.id}/correction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ original: originalText, correct }),
          }).then((x) => x.json());
          if (r.ok) {
            msg.textContent = '✓ 已保存，正在刷新';
            setTimeout(() => { close(); refreshJobAfterCorrection(job.id); }, 500);
          } else {
            msg.textContent = r.error || '保存失败';
            saveBtn.disabled = false;
          }
        } catch (e) {
          msg.textContent = '网络错误';
          saveBtn.disabled = false;
        }
      };
    }
  }

  // 修正后刷新任务详情（重新渲染正文 + 质量标记）
  async function refreshJobAfterCorrection(id) {
    const d = await apiFetch(`/api/jobs/${id}`).then((r) => r.json()).then((x) => x.job).catch(() => null);
    if (!d) return;
    state.jobs.set(id, d);
    renderJobList();
    if (state.selectedId === id) renderDetail(d);
    flashToast('修正已生效，检索将使用修正后的内容');
  }
  /* ---------- 流水线筛选 / 批量选择 ---------- */
  function toggleSelect(id) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    renderJobList();
  }

  document.querySelectorAll('.pf').forEach((b) => {
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      if (state.filter === 'trash' && state.selectMode) { state.selectMode = false; state.selectedIds.clear(); }
      document.querySelectorAll('.pf').forEach((x) => x.classList.toggle('active', x === b));
      renderJobList();
    });
  });

  $('#btn-select').addEventListener('click', () => {
    state.selectMode = true;
    state.selectedIds.clear();
    renderJobList();
  });
  $('#batch-exit').addEventListener('click', () => {
    state.selectMode = false;
    state.selectedIds.clear();
    renderJobList();
  });

  // 全选/取消全选（切换式）：选中所有可操作任务（解析中除外）
  $('#batch-all').addEventListener('click', () => {
    // 只全选当前筛选视图下可见的可操作任务（解析中除外）
    const operable = getFilteredJobs().filter((j) => j.status !== 'running').map((j) => j.id);
    const allSelected = operable.length > 0 && operable.every((id) => state.selectedIds.has(id));
    if (allSelected) operable.forEach((id) => state.selectedIds.delete(id));
    else operable.forEach((id) => state.selectedIds.add(id));
    renderJobList();
  });

  function runBatch(action) {
    const ids = [...state.selectedIds];
    if (!ids.length) { flashToast('请先勾选任务'); return; }
    const exec = () => apiFetch('/api/jobs/batch-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ids }),
    }).then((r) => r.json()).then((d) => {
      const fail = d.failed || [];
      if (fail.length) flashToast(`${d.ok.length} 项成功，${fail.length} 项失败：${fail[0].error}`);
      else flashToast(`批量${action === 'delete' ? '已移入回收站' : action === 'retry' ? '重试' : '取消'}完成：${d.ok.length} 项`);
      if (action === 'delete' && ids.includes(state.selectedId)) { state.selectedId = null; $('#detail').hidden = true; $('#detail-empty').hidden = false; }
      state.selectedIds.clear();
      refreshAllLists();
    }).catch(() => flashToast('批量操作失败'));
    if (action === 'delete') {
      showConfirm({
        title: `批量删除 ${ids.length} 个任务`,
        message: `将永久删除当前勾选的 ${ids.length} 个任务，其产物文件和知识库记录一并清除，此操作不可恢复。确认继续？`,
        confirmText: '删除',
        danger: true,
        glyph: '🗑',
      }).then((ok) => { if (ok) exec(); });
    } else exec();
  }
  $('#batch-delete').addEventListener('click', () => runBatch('delete'));
  $('#batch-retry').addEventListener('click', () => runBatch('retry'));
  $('#batch-cancel').addEventListener('click', () => runBatch('cancel'));

  // 统一刷新：流水线 + 回收站
  async function refreshAllLists() {
    const [a, t] = await Promise.all([
      apiFetch('/api/jobs').then((r) => r.json()).catch(() => ({ jobs: [] })),
      apiFetch('/api/trash').then((r) => r.json()).catch(() => ({ jobs: [] })),
    ]);
    state.jobs = new Map((a.jobs || []).map((j) => [j.id, j]));
    state.trashJobs = new Map((t.jobs || []).map((j) => [j.id, j]));
    renderJobList();
  }

  $('#btn-empty-trash').addEventListener('click', () => {
    const n = state.trashJobs.size;
    if (!n) { flashToast('回收站为空'); return; }
    showConfirm({
      title: '清空回收站',
      message: `将彻底删除回收站中的 ${n} 个任务及其全部文件，此操作不可恢复。确认？`,
      confirmText: '清空',
      danger: true,
      glyph: '🗑',
    }).then((ok) => {
      if (!ok) return;
      apiFetch('/api/trash/clear', { method: 'POST' }).then((r) => r.json()).then((d) => {
        if (d.ok) { flashToast(`已清空回收站（${d.cleared} 项）`); refreshAllLists(); }
        else flashToast('清空失败');
      }).catch(() => flashToast('清空失败'));
    });
  });

  async function refreshStatus() {
    try {
      const h = await apiFetch('/api/health').then((r) => r.json());
      if (h.maxUploadMb) state.maxUploadMb = h.maxUploadMb;
      const ok = h.daytona === 'ok';
      const started = ok && h.sandbox && h.sandbox.state === 'started';
      $('#st-daytona').className = 'dot ' + (ok ? 'dot-ok' : 'dot-err');
      $('#cloud-chip-txt').textContent = ok ? (started ? '就绪' : '待初始化') : '离线';
      // 初始化按钮仅在"待初始化"时展示（且仅 admin）；就绪时点了无意义，离线时点了也白点
      $('#btn-init').hidden = state.initBusy || state.userRole !== 'admin' || !(ok && h.sandbox && h.sandbox.state !== 'started');
      $('#st-sandbox').textContent = h.sandbox ? h.sandbox.state : '—';
      $('#st-workdir').textContent = h.workDir || '—';
      // 销毁沙箱是低频排障操作（仅 admin），收进状态栏：系统记录过沙箱才显示
      $('#btn-destroy').hidden = state.userRole !== 'admin' || !h.sandbox;
    } catch { /* noop */ }
  }

  $('#btn-init').addEventListener('click', async () => {
    const btn = $('#btn-init');
    // 先校验当前状态：已就绪则无需初始化，避免误导性提示
    const st = await apiFetch('/api/admin/status').then((r) => r.json()).catch(() => null);
    if (st && st.sandbox?.state === 'started' && st.mineru) {
      flashToast('云端环境已就绪，无需初始化');
      refreshStatus();
      return;
    }
    const firstTime = !st || !st.sandbox; // 无沙箱记录 = 首次构建环境
    state.initBusy = true;
    btn.disabled = true; btn.textContent = '初始化中…';
    flashToast(firstTime ? '正在准备云端解析环境（首次约 8-20 分钟）' : '正在启动/校验云端环境…');
    try {
      await apiFetch('/api/admin/init', { method: 'POST' });
      const iv = setInterval(async () => {
        const s = await apiFetch('/api/admin/status').then((r) => r.json()).catch(() => null);
        if (!s) return;
        $('#st-sandbox').textContent = s.sandbox?.state || '—';
        $('#st-workdir').textContent = s.workDir || '—';
        if (s.sandbox?.state === 'started' && s.mineru) {
          clearInterval(iv);
          state.initBusy = false;
          btn.disabled = false; btn.textContent = '⟳ 初始化';
          flashToast('云端解析环境就绪');
          refreshStatus();
        }
      }, 4000);
    } catch (e) {
      state.initBusy = false;
      btn.disabled = false; btn.textContent = '⟳ 初始化';
      flashToast('初始化失败: ' + e.message);
    }
  });

  $('#btn-destroy').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: '销毁云端沙箱',
      message: '确认销毁你的云端沙箱？已入库结果保留；模型在共享快照中不受影响，下次任务将从快照秒开重建。',
      confirmText: '销毁',
      danger: true,
      glyph: '⚠',
    });
    if (!ok) return;
    const r = await apiFetch('/api/admin/sandbox', { method: 'DELETE' }).then((x) => x.json()).catch(() => ({ ok: false }));
    flashToast(r.ok ? '沙箱已销毁' : `销毁失败：${r.error || '请查看服务端日志'}`);
    refreshStatus();
  });

  /* ---------- Toast ---------- */
  let toastEl = null;
  function flashToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--paper);font-family:var(--mono);font-size:11px;padding:10px 18px;z-index:99;box-shadow:3px 3px 0 var(--accent);letter-spacing:.03em;max-width:80vw';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.style.display = 'none'; }, 4200);
  }

  /* ---------- 自定义确认弹窗（替代浏览器 confirm） ---------- */
  function showConfirm({ title, message, confirmText = '确认', danger = false, glyph = '🗑' }) {
    return new Promise((resolve) => {
      const mask = $('#confirm-mask');
      $('#confirm-title').textContent = title;
      $('#confirm-msg').textContent = message;
      $('#confirm-glyph').textContent = glyph;
      const yes = $('#confirm-yes');
      yes.textContent = confirmText;
      yes.className = 'btn ' + (danger ? 'btn-danger' : '');
      mask.hidden = false;

      const cleanup = (result) => {
        mask.hidden = true;
        yes.onclick = null;
        $('#confirm-no').onclick = null;
        mask.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };
      yes.onclick = () => cleanup(true);
      $('#confirm-no').onclick = () => cleanup(false);
      mask.onclick = (e) => { if (e.target === mask) cleanup(false); };
      document.addEventListener('keydown', onKey);
      yes.focus();
    });
  }
})();
