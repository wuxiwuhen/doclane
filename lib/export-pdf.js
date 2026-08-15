// lib/export-pdf.js — 服务端 md → PDF
// 流程：marked + KaTeX 渲染成带样式的 HTML → headless Chrome (系统浏览器) 输出 PDF
// 保真度高：公式（KaTeX 矢量）、表格、中文、代码块均与正文一致
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { marked } from 'marked';
import katex from 'katex';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// marked 数学扩展（与前端一致）：$$...$$ 块级、$...$ 行内 → KaTeX
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
      catch { return token.raw; }
    },
  }],
});

// 查找系统可用的 Chrome 系浏览器（本地模式用）
function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    process.env.CHROME_PATH,
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

// 启动浏览器：优先系统 Chrome（本地）；否则无服务器 Chromium（Vercel 函数）
async function launchBrowser() {
  const chromePath = findChrome();
  const args = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'];
  if (chromePath) {
    return { browser: await puppeteer.launch({ executablePath: chromePath, args, headless: true }), src: 'local' };
  }
  const chromium = await import('@sparticuz/chromium');
  return {
    browser: await puppeteer.launch({
      executablePath: await chromium.executablePath(),
      args: [...args, ...chromium.args],
      headless: chromium.headless,
    }),
    src: 'vercel',
  };
}

const BODY_CSS = `
  body { font-family: "Songti SC","STSong","SimSun",Georgia,serif; color:#222; font-size:13px; line-height:1.75; margin:0; }
  .doc { max-width: 760px; margin: 0 auto; }
  h1,h2,h3,h4 { font-weight:700; line-height:1.3; }
  h1 { font-size:26px; border-bottom:2px solid #333; padding-bottom:8px; margin:0 0 16px; }
  h2 { font-size:20px; margin-top:26px; }
  h3 { font-size:16px; margin-top:20px; }
  p { margin:10px 0; }
  ul,ol { margin:10px 0; padding-left:26px; }
  li { margin:4px 0; }
  table { border-collapse:collapse; width:100%; margin:14px 0; font-size:12px; }
  th,td { border:1px solid #b8b2a4; padding:6px 10px; text-align:left; }
  th { background:#f2efe8; }
  img { max-width:100%; }
  pre { background:#f6f4ee; padding:12px 14px; overflow-x:auto; font-size:11px; line-height:1.6; white-space:pre-wrap; }
  code { background:#f2efe8; padding:1px 4px; font-size:12px; }
  pre code { background:none; padding:0; }
  blockquote { border-left:3px solid #c8402a; margin:12px 0; padding:6px 14px; color:#555; font-style:italic; }
  a { color:#9f2f1d; }
  hr { border:none; border-top:1px solid #ccc; margin:22px 0; }
  .katex { font-size:1.05em; }
  .katex-display { margin:12px 0; overflow-x:auto; }
  .katex-error { color:#c8402a; font-family:monospace; font-size:12px; }
`;

/**
 * 渲染 markdown 为 PDF
 * @param {string} md markdown 原文
 * @param {object} opts { baseUrl, imagePrefix, title }
 * @returns {Promise<Buffer>} PDF 内容
 */
export async function exportPdf(md, { baseUrl = 'http://127.0.0.1:3088', imagePrefix = '', title = '' } = {}) {
  // 图片相对路径 → 绝对 URL（本服务可访问）
  const renderer = new marked.Renderer();
  renderer.html = (token) => esc(token.text ?? token.raw ?? '');
  const origImage = renderer.image.bind(renderer);
  renderer.image = (tokens) => {
    let src = tokens.href;
    if (src && !/^(https?:|data:|\/)/.test(src)) {
      const rel = src.replace(/^\.\//, '');
      src = `${baseUrl}${imagePrefix}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    }
    return origImage({ href: src, title: tokens.title, text: tokens.text });
  };

  const bodyHtml = marked.parse(md, { renderer });
  const katexCss = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.min.css'), 'utf8')
    .replace(/url\(fonts\//g, `url(${baseUrl}/vendor/katex/fonts/`);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>${katexCss}${BODY_CSS}</style>
</head>
<body><article class="doc">${bodyHtml}</article></body>
</html>`;

  const { browser } = await launchBrowser();
  try {
    const page = await browser.newPage();
    // 'load' 足够（页面骨架加载完）；PDF 输出前等待字体就绪
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: false, // 不显示页眉页脚
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
