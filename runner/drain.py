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
    logf = open("/tmp/mineru-run.log", "ab")
    proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, env=env)
    deadline = time.time() + 40 * 60
    while proc.poll() is None:
        if time.time() > deadline:
            proc.kill()
            raise RuntimeError("MinerU 提取超时（40 分钟）")
        time.sleep(10)
    logf.close()
    if proc.returncode != 0:
        tail = ""
        try:
            tail = Path("/tmp/mineru-run.log").read_text(errors="ignore")[-1500:]
        except OSError:
            pass
        raise RuntimeError(f"MinerU 退出码 {proc.returncode}：\n{tail[-800:]}")
    on_log("提取完成，收集产物…")

# ---------- 主流程 ----------
def main():
    if not JOB_ID or not SUPABASE_URL or not SERVICE_KEY:
        print("usage: python3 drain.py <job_id>  (需要 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 环境变量)")
        sys.exit(2)
    job = load_job()
    append_log(job, "任务执行器已启动")
    set_status(job, "preparing")
    try:
        work = Path("/tmp/doclane-work")
        (work / "out").mkdir(parents=True, exist_ok=True)
        input_path = work / ("input" + (job.get("ext") or ".bin"))

        # 1. 下载输入（input_storage_path 是桶内相对路径，需补桶名）
        append_log(job, "下载输入文件…")
        data = storage_get("inputs/" + job["input_storage_path"])
        input_path.write_bytes(data)

        # 2. 提取
        set_status(job, "running")
        run_mineru(input_path, work / "out", lambda m: append_log(job, m))

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
        saved.sort(key=lambda x: (not x["isMd"], x["rel"]))
        if not main_md_path:
            raise RuntimeError("未找到任何 markdown 产物")

        # 4. 入库（文档 + chunk + bigram）——先清旧记录再写入（重试复用同一 job id，幂等）
        main_md = storage_get(f"outputs/{JOB_ID}/{main_md_path}").decode("utf-8", errors="replace")
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

if __name__ == "__main__":
    main()
