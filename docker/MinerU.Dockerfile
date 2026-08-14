# MinerU 内容提取镜像 —— 轻量 CPU 版（用于 Daytona 沙箱 buildInfo 构建）
# 覆盖 PDF / 图片 / DOCX / PPTX / XLSX 全部格式；CPU 版 torch 以适配 10GB 磁盘配额。
FROM python:3.11-slim

# OpenCV / onnxruntime / 中文渲染所需系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libsm6 \
        libxext6 \
        fonts-noto-cjk \
        fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# 先装 CPU 版 torch/torchvision，避免默认拉取 CUDA 版撑爆磁盘
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# MinerU 3.x（含 pipeline 后端；模型首次运行自动下载到 ~/.cache/huggingface）
RUN pip install --no-cache-dir 'mineru[core]>=3.4.0' && pip cache purge

# 入口保持为 bash，便于在沙箱内任意执行命令
ENTRYPOINT ["/bin/bash", "-c", "exec \"$@\"", "--"]
