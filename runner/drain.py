#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
drain.py — Daytona 沙箱内的一次性任务执行器（纯 Python 标准库，零依赖）
用法: python3 drain.py <job_id>
流程: 读任务 → 下载输入 → MinerU 提取 → 上传产物 → 入库(文档+chunk+bigram) → 更新状态
由 Vercel ensure 函数注入沙箱并 nohup 启动；处理完即退出，沙箱 autoStop 尾保回收。
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
EMBED_BASE = (os.environ.get("EMBEDDING_BASE_URL") or "").rstrip("/")
EMBED_KEY = os.environ.get("EMBEDDING_API_KEY", "")
EMBED_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")
JOB_ID = sys.argv[1] if len(sys.argv) > 1 else ""
APP_URL = (os.environ.get("APP_URL") or "").rstrip("/")     # 任务结束回调（释放沙箱）
RELEASE_SECRET = os.environ.get("RELEASE_SECRET", "")
JOB_TIMEOUT_MIN = int(os.environ.get("JOB_TIMEOUT_MIN", "30"))  # 单任务总时长上限
DEADLINE = time.time() + JOB_TIMEOUT_MIN * 60 if JOB_ID else 0  # 全局超时（防单个任务耗尽沙箱额度）

MODEL_CACHE = os.path.expanduser("~/.cache/huggingface/hub/models--opendatalab--PDF-Extract-Kit-1.0")

# ---------- Supabase REST 直连（service role） ----------
def sb_headers(extra=None):
    h = {
        "Authorization": "Bearer " + SERVICE_KEY,
        "apikey": SERVICE_KEY,
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h

def sb_get(table, query="select=*"):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{query}"
    req = urllib.request.Request(url, headers=sb_headers(), method="GET")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def sb_patch(table, id_col, id_val, fields):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{id_col}=eq.{id_val}"
    req = urllib.request.Request(url, data=json.dumps(fields).encode(),
                                 headers=sb_headers({"Prefer": "return=representation"}), method="PATCH")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def sb_insert(table, rows):
    if not rows:
        return []
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{table}?select=id",
                                 data=json.dumps(rows).encode(),
                                 headers=sb_headers({"Prefer": "return=representation"}), method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def sb_delete(table, col, val):
    """按列等值删除（先删子表再删父表，避免外键/主键冲突）"""
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{table}?{col}=eq.{val}",
                                 headers=sb_headers(), method="DELETE")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status

def storage_get(path):
    url = f"{SUPABASE_URL}/storage/v1/object/{path}"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + SERVICE_KEY, "apikey": SERVICE_KEY})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()

def storage_put(path, data, ctype="application/octet-stream"):
    url = f"{SUPABASE_URL}/storage/v1/object/{path}"
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Authorization": "Bearer " + SERVICE_KEY, "apikey": SERVICE_KEY,
                                          "Content-Type": ctype,
                                          "x-upsert": "true"})  # 覆盖已存在产物（任务重试幂等）
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.status

# ---------- 文本处理（与 lib/knowledge.js 一致） ----------
CJK_RE = re.compile(r"[\u4e00-\u9fff]+")

def to_bigrams(text):
    """中文连续段按 2 字符滑动窗口切词，非中文保留为词；与前端/旧库一致。"""
    def repl(m):
        zh = m.group(0)  # re.sub 的替换函数收到的是 match 对象
        if len(zh) == 1:
            return zh + " "
        return " ".join(zh[i:i + 2] for i in range(len(zh) - 1)) + " "
    return re.sub(r"\s+", " ", CJK_RE.sub(repl, str(text or ""))).strip()

def chunk_md(main_md):
    paras = [p.strip() for p in re.split(r"\n{2,}", str(main_md or ""))]
    return [p for p in paras if p]

# ---------- 任务辅助 ----------
def load_job():
    rows = sb_get("jobs", f"id=eq.{JOB_ID}&select=*")
    if not rows:
        raise RuntimeError(f"任务 {JOB_ID} 不存在")
    return rows[0]

def append_log(job, msg):
    logs = list(job.get("logs") or [])
    logs.append({"t": int(time.time() * 1000), "msg": msg})
    sb_patch("jobs", "id", job["id"], {"logs": logs})
    job["logs"] = logs

def set_status(job, status, **fields):
    patch = {"status": status, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields}
    rows = sb_patch("jobs", "id", job["id"], patch)
    if rows:
        job.update(rows[0])

def run_mineru(input_path, out_dir, on_log):
    model_src = "local" if os.path.isdir(MODEL_CACHE) else "huggingface"
    env = dict(os.environ, MINERU_MODEL_SOURCE=model_src)
    flags = ["--backend", "pipeline"]
    cmd = ["mineru", "-p", str(input_path), "-o", str(out_dir)] + flags
    on_log(f"启动 MinerU: {' '.join(cmd)}（模型源 {model_src}）")
    logf = open(f"/tmp/mineru-{JOB_ID}.log", "ab")
    proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, env=env)
    # 提取超时 = min(40 分钟, 任务剩余时长)
    remain = int(DEADLINE - time.time()) if DEADLINE else 40 * 60
    timeout_s = max(60, min(40 * 60, remain))
    deadline = time.time() + timeout_s
    while proc.poll() is None:
        if time.time() > deadline:
            proc.kill()
            raise RuntimeError(f"MinerU 提取超时（{timeout_s // 60} 分钟）")
        time.sleep(10)
    logf.close()
    if proc.returncode != 0:
        tail = ""
        try:
            tail = Path(f"/tmp/mineru-{JOB_ID}.log").read_text(errors="ignore")[-1500:]
        except OSError:
            pass
        raise RuntimeError(f"MinerU 退出码 {proc.returncode}：\n{tail[-800:]}")
    on_log("提取完成，收集产物…")

def check_deadline():
    if DEADLINE and time.time() > DEADLINE:
        raise RuntimeError(f"任务超时（{JOB_TIMEOUT_MIN} 分钟上限）")

def release_sandbox():
    """任务结束（成功/失败）回调 Vercel：该用户无排队任务则销毁沙箱（用完即毁）。
    失败静默——沙箱还有 autoStop/TTL 兜底回收。"""
    if not APP_URL:
        return
    try:
        data = json.dumps({"jobId": JOB_ID}).encode()
        req = urllib.request.Request(APP_URL + "/api/sandbox/release", data=data, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "X-Release-Secret": RELEASE_SECRET})
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass

# ---------- 本地模式（纯本地模式：只做文件计算，不访问 Supabase） ----------
def local_main(input_path, out_dir):
    """本地模式：给定输入/输出路径，MinerU 提取后写产物清单 manifest.json。
    日志走 stdout（由本地 server 收集写入任务日志）。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    run_mineru(input_path, out, lambda m: print(m, flush=True))
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name != "manifest.json")
    manifest = [{"rel": p.relative_to(out).as_posix(), "size": p.stat().st_size} for p in files]
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    print("DONE", flush=True)

# ---------- 主流程 ----------
def main():
    if len(sys.argv) > 2 and sys.argv[2] == "--local":
        if len(sys.argv) < 5:
            print("usage: python3 drain.py <job_id> --local <input_path> <output_dir>")
            sys.exit(2)
        try:
            local_main(sys.argv[3], sys.argv[4])
        except Exception as e:
            print("ERROR:", e, file=sys.stderr, flush=True)
            sys.exit(1)
        return
    if not JOB_ID or not SUPABASE_URL or not SERVICE_KEY:
        print("usage: python3 drain.py <job_id>  (需要 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 环境变量)")
        sys.exit(2)
    job = load_job()
    append_log(job, "任务执行器已启动")
    set_status(job, "preparing")
    try:
        work = Path("/tmp/doclane-work") / JOB_ID   # 每任务独立工作目录（并发/重试隔离）
        (work / "out").mkdir(parents=True, exist_ok=True)
        input_path = work / ("input" + (job.get("ext") or ".bin"))

        # 1. 下载输入（input_storage_path 是桶内相对路径，需补桶名）
        append_log(job, "下载输入文件…")
        data = storage_get("inputs/" + job["input_storage_path"])
        input_path.write_bytes(data)
        check_deadline()

        # 2. 提取
        set_status(job, "running")
        run_mineru(input_path, work / "out", lambda m: append_log(job, m))
        check_deadline()

        # 3. 上传产物
        append_log(job, "上传产物到 Storage…")
        files = sorted(p for p in (work / "out").rglob("*") if p.is_file())
        saved = []
        main_md_path = None
        for f in files:
            rel = f.relative_to(work / "out").as_posix()
            ctype = "text/markdown; charset=utf-8" if f.suffix.lower() == ".md" else "application/octet-stream"
            storage_put(f"outputs/{JOB_ID}/{rel}", f.read_bytes(), ctype)
            is_md = rel.lower().endswith(".md")
            saved.append({"rel": rel, "size": f.stat().st_size, "isMd": is_md})
            if is_md and main_md_path is None:
                main_md_path = rel
            check_deadline()
        saved.sort(key=lambda x: (not x["isMd"], x["rel"]))
        if not main_md_path:
            raise RuntimeError("未找到任何 markdown 产物")

        # 4. 入库（文档 + chunk + bigram）——先清旧记录再写入（重试复用同一 job id，幂等）
        main_md = storage_get(f"outputs/{JOB_ID}/{main_md_path}").decode("utf-8", errors="replace")
        check_deadline()
        append_log(job, f"入库知识库（{len(chunk_md(main_md))} 个片段）…")
        sb_delete("chunks", "doc_id", JOB_ID)
        sb_delete("documents", "id", JOB_ID)
        sb_insert("documents", [{
            "id": JOB_ID, "job_id": JOB_ID, "filename": job["original_name"], "ext": job.get("ext") or "",
            "size": job.get("size") or 0, "main_md": main_md,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }])
        paras = chunk_md(main_md)
        for i, p in enumerate(paras):
            sb_insert("chunks", [{"doc_id": JOB_ID, "seq": i, "content": p,
                                  "content_bigrams": to_bigrams(p)}])

        # 5. 完成
        set_status(job, "done", files=saved, main_md_path=main_md_path, error=None,
                   quality={"level": "ok"})
        append_log(job, f"完成：{len(saved)} 个产物，{len(paras)} 个检索片段")
        print("DONE")
    except Exception as e:
        try:
            append_log(job, f"失败：{str(e)[:500]}")
            set_status(job, "error", error=str(e)[:1000])
        except Exception:
            pass
        print("ERROR:", e, file=sys.stderr)
        sys.exit(1)
    finally:
        release_sandbox()  # 成功/失败都尝试释放沙箱（无排队任务则销毁，用完即毁）

if __name__ == "__main__":
    main()
