'use strict';

const templates = window.INVITATION_TEMPLATES;
const exporter = window.InvitationExport;
let template = templates.guoo;
let activeMode = 'guoo';
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const canvas = document.getElementById('invitation');
const ctx = canvas.getContext('2d');
const input = document.getElementById('guest-name');
const button = document.getElementById('save-button');
const form = document.getElementById('invitation-form');
const hint = document.getElementById('field-hint');
const count = document.getElementById('count');
const status = document.getElementById('status');
const dialog = document.getElementById('save-dialog');
let cleanTemplate;
let saving = false;
let currentResult;
let shareBusy = false;
const heldURLs = new Set();
const saveImage = document.getElementById('save-image');
const dialogStatus = document.getElementById('dialog-status');
let loadRevision = 0;
const templateCache = new Map();
const issuerOptions = document.getElementById('issuer-options');
const PREVIEW_MAX_WIDTH = 1052;

function getName() { return input.value.replace(/\s+/gu, ' ').trim(); }
function nameLength(name) { return Array.from(name).length; }
function dimensionsAtScale(config, scale) {
  return { width: Math.round(config.width * scale), height: Math.round(config.height * scale) };
}
function previewDimensions(config) {
  return dimensionsAtScale(config, Math.min(1, PREVIEW_MAX_WIDTH / config.width));
}
async function loadTemplateImage(config, forPreview = false) {
  return exporter.loadImage(forPreview && config.previewSrc ? config.previewSrc : config.src);
}

// Fill only the editable greeting area from the untouched background immediately
// above/below it. All other original image pixels are retained at source size.
function eraseText(context, bounds) {
  const { x, y, width, height } = bounds;
  const above = context.getImageData(x, y - 2, width, 1).data;
  const below = context.getImageData(x, y + height + 2, width, 1).data;
  const patch = context.createImageData(width, height);
  for (let row = 0; row < height; row++) {
    const t = (row + 2) / (height + 4);
    for (let col = 0; col < width; col++) {
      const offset = (row * width + col) * 4;
      for (let channel = 0; channel < 3; channel++) {
        patch.data[offset + channel] = Math.round(above[col * 4 + channel] * (1 - t) + below[col * 4 + channel] * t);
      }
      patch.data[offset + 3] = 255;
    }
  }
  context.putImageData(patch, x, y);
}

function prepareTemplate(image, config, dimensions) {
  const base = document.createElement('canvas');
  base.width = dimensions.width;
  base.height = dimensions.height;
  const context = base.getContext('2d');
  context.drawImage(image, 0, 0, base.width, base.height);
  if (config.erase && config.erase.width > 0 && config.erase.height > 0) {
    const scale = base.width / config.width;
    const x = Math.floor(config.erase.x * scale);
    const y = Math.floor(config.erase.y * scale);
    eraseText(context, {
      x, y,
      width: Math.ceil((config.erase.x + config.erase.width) * scale) - x,
      height: Math.ceil((config.erase.y + config.erase.height) * scale) - y,
    });
  }
  return base;
}

function drawName(context, name, config, scale) {
  const style = config.name;
  const unit = config.width / 841;
  context.save();
  context.scale(scale, scale);
  let size = style.fontSize;
  context.font = `700 ${size}px ${FONT}`;
  while (context.measureText(name).width > style.maxWidth && size > style.minFontSize) {
    size = Math.max(style.minFontSize, size - .5 * unit);
    context.font = `700 ${size}px ${FONT}`;
  }
  const measured = context.measureText(name).width;
  const width = Math.min(measured, style.maxWidth);
  context.fillStyle = config.color;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillText(name, style.x, style.baseline, style.maxWidth);
  context.fillStyle = config.accent;
  context.fillRect(style.x - 6 * unit, style.baseline + 7 * unit, width + 12 * unit, unit);
  context.font = `700 ${28 * unit}px ${FONT}`;
  context.fillText('：', style.x + width + 11 * unit, style.baseline);
  context.restore();
}

function render(name) {
  ctx.drawImage(cleanTemplate, 0, 0);
  drawName(ctx, name, template, canvas.width / template.width);
  canvas.setAttribute('aria-label', `邀请函预览，受邀人：${name}`);
}

function update() {
  const name = getName();
  const length = nameLength(name);
  const tooLong = length > template.maxLength;
  count.textContent = `${length} / ${template.maxLength}`;
  input.setAttribute('aria-invalid', String(tooLong));
  hint.textContent = tooLong ? '名称请控制在 24 个字以内' : '名称会自动显示在邀请函中';
  hint.classList.toggle('error', tooLong);
  button.disabled = !cleanTemplate || !length || tooLong || saving;
  if (cleanTemplate) render(tooLong ? '受邀人名称' : name || '受邀人名称');
  status.textContent = '';
}

function setBusy(busy) {
  saving = busy;
  button.disabled = busy || !cleanTemplate || !getName() || nameLength(getName()) > template.maxLength;
  issuerOptions.disabled = busy;
  input.readOnly = busy;
  form.setAttribute('aria-busy', String(busy));
  document.getElementById('save-label').textContent = busy ? '正在生成完整长图…' : '生成并预览邀请函';
}
function overlay(context, dimensions, name, config) {
  const scale = dimensions.width / config.width;
  if (config.erase) {
    const x = Math.floor(config.erase.x * scale);
    const y = Math.floor(config.erase.y * scale);
    eraseText(context, { x, y,
      width: Math.ceil((config.erase.x + config.erase.width) * scale) - x,
      height: Math.ceil((config.erase.y + config.erase.height) * scale) - y });
  }
  drawName(context, name, config, scale);
}
function canShare(result) {
  try { return !!result.file && typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [result.file] }); } catch (_) { return false; }
}
function showDialog() {
  dialog.hidden = false;
  if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
  else { dialog.classList.add('dialog-fallback'); dialog.setAttribute('open', ''); }
  document.body.classList.add('result-open');
}
function closeDialog() {
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
  dialog.hidden = true;
  document.body.classList.remove('result-open');
  button.focus();
}
async function showResult(result) {
  const old = currentResult;
  result.url = URL.createObjectURL(result.blob);
  heldURLs.add(result.url);
  try {
    // Data URLs are kept intact for native long-press saving in iOS/WebViews.
    const preview = result.onPhone ? await exporter.dataURL(result.blob) : result.url;
    const loaded = new Promise((resolve, reject) => {
      saveImage.onload = resolve;
      saveImage.onerror = () => reject(new Error('完整图片预览失败，请点击重试。'));
    });
    loaded.catch(() => {});
    saveImage.src = preview;
    await exporter.deadline(typeof saveImage.decode === 'function' ? saveImage.decode() : loaded,
      20000, '完整图片预览超时，请点击重试。');
    saveImage.onload = saveImage.onerror = null;
    saveImage.alt = `${result.label}邀请函，受邀人：${result.name}，含完整正文及落款`;
    currentResult = result;
    document.getElementById('open-full').href = result.url;
    document.getElementById('share-image').hidden = !canShare(result);
    document.getElementById('result-meta').textContent = `完整长图 · ${result.width} × ${result.height} · ${result.format}`;
    document.getElementById('save-instructions').textContent = exporter.webview()
      ? '微信／企业微信：长按下方完整图片，选择保存图片。若没有保存选项，请通过右上角菜单在系统浏览器打开。'
      : result.onPhone ? '可使用系统分享面板、下载图片，或长按下方完整图片保存。下载文件不等于已写入相册。'
      : '请查看完整图片，确认正文及落款后下载。';
    dialogStatus.textContent = result.reduced ? '已自动采用较低内存的方式生成完整图片。' : '';
    showDialog();
    // Never revoke an image while a native save/open operation may still read it.
    if (old) setTimeout(() => { URL.revokeObjectURL(old.url); heldURLs.delete(old.url); }, 60000);
  } catch (error) {
    URL.revokeObjectURL(result.url); heldURLs.delete(result.url);
    throw error;
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const name = getName();
  if (!cleanTemplate || !name || nameLength(name) > template.maxLength || saving || shareBusy) return;
  const config = template;
  setBusy(true);
  status.textContent = '正在等待图片和字体加载…';
  let failed = false;
  try {
    const result = await exporter.create(config, (context, dimensions) => overlay(context, dimensions, name, config),
      message => { status.textContent = message; });
    result.name = name; result.label = config.label;
    const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    result.filename = `${config.label}-邀请函-${safeName}.${result.blob.type === 'image/jpeg' ? 'jpg' : 'png'}`;
    if (typeof File === 'function') result.file = new File([result.blob], result.filename, { type: result.blob.type });
    await showResult(result);
    status.textContent = '完整邀请函已生成，请在预览中选择保存方式。';
  } catch (error) {
    failed = true;
    status.textContent = error.message || '生成失败，请点击下方按钮重试。';
    console.error('Invitation export failed', error);
  } finally {
    setBusy(false);
    if (failed) document.getElementById('save-label').textContent = '重试生成邀请函';
  }
});
document.getElementById('share-image').addEventListener('click', async () => {
  const result = currentResult;
  if (!result || shareBusy || !canShare(result)) return;
  shareBusy = true;
  document.getElementById('share-image').disabled = true;
  document.getElementById('download-image').disabled = true;
  try {
    // First asynchronous action in this click: retain Web Share user activation.
    await navigator.share({ files: [result.file], title: `${result.label}邀请函` });
    dialogStatus.textContent = '系统分享操作已结束，请在所选应用或相册中确认结果。';
  } catch (error) {
    dialogStatus.textContent = error.name === 'AbortError'
      ? '已取消分享，图片仍可下载或长按保存。'
      : '当前浏览器未能分享图片，请下载或长按图片保存。';
  } finally {
    shareBusy = false;
    document.getElementById('share-image').disabled = false;
    document.getElementById('download-image').disabled = false;
  }
});
document.getElementById('download-image').addEventListener('click', () => {
  if (!currentResult || shareBusy) return;
  const link = document.createElement('a');
  if (!('download' in link)) {
    dialogStatus.textContent = '当前浏览器不支持直接下载，请长按图片保存，或打开完整图片。';
    return;
  }
  link.href = currentResult.url; link.download = currentResult.filename;
  document.body.appendChild(link); link.click(); link.remove();
  dialogStatus.textContent = exporter.webview()
    ? '已尝试下载。微信／企业微信可能拦截下载，请长按图片保存，或在系统浏览器打开。'
    : '已发起文件下载，请查看浏览器下载列表或文件应用；下载不会自动写入相册。';
});
document.getElementById('retry-export').addEventListener('click', () => {
  if (shareBusy) return;
  closeDialog();
  if (typeof form.requestSubmit === 'function') form.requestSubmit(); else button.click();
});
input.addEventListener('input', event => { if (!event.isComposing) update(); });
input.addEventListener('compositionend', update);
document.getElementById('close-dialog').addEventListener('click', closeDialog);
dialog.addEventListener('close', () => { dialog.hidden = true; document.body.classList.remove('result-open'); });
dialog.addEventListener('click', event => { if (event.target === dialog) {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
} });

async function loadMode(mode) {
  const revision = ++loadRevision;
  activeMode = mode;
  template = templates[mode];
  cleanTemplate = null;
  const loading = document.getElementById('loading');
  loading.hidden = false;
  loading.textContent = '正在载入邀请函…';
  const dimensions = previewDimensions(template);
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  document.querySelector('.paper').style.aspectRatio = `${template.width} / ${template.height}`;
  document.getElementById('issuer-footer').textContent = template.label;
  document.getElementById('template-note').textContent = `${template.label} · 预览即保存效果`;
  update();
  try {
    if (!templateCache.has(mode)) {
      const config = template;
      templateCache.set(mode, (async () => {
        const image = await loadTemplateImage(config, true);
        try {
          await document.fonts.ready;
          return prepareTemplate(image, config, previewDimensions(config));
        } finally {
          image.src = '';
        }
      })());
    }
    const base = await templateCache.get(mode);
    if (revision !== loadRevision) return;
    cleanTemplate = base;
    loading.hidden = true;
    update();
  } catch (error) {
    templateCache.delete(mode);
    if (revision !== loadRevision) return;
    loading.textContent = '邀请函加载失败，请刷新页面重试';
    status.textContent = '请检查网络后刷新页面。';
    console.error('Invitation template failed to load', error);
  }
}

issuerOptions.addEventListener('change', event => {
  if (event.target.name === 'issuer' && event.target.value !== activeMode) loadMode(event.target.value);
});
loadMode('guoo');
