// lib/state.js — 轻量 JSON 状态持久化（快照/沙箱 ID、工作目录、CLI 能力缓存）
import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }
  get() {
    return this.data;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
