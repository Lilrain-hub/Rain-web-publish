'use strict';

const templates = window.INVITATION_TEMPLATES;
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
let resultURL;
let loadRevision = 0;
const templateCache = new Map();
const issuerOptions = document.getElementById('issuer-options');
const PREVIEW_MAX_WIDTH = 1052;
const TOUCH_EXPORT_MAX_EDGE = 4096;

function getName() { return input.value.replace(/\s+/gu, ' ').trim(); }
function nameLength(name) { return Array.from(name).length; }
function isMobileSave() {
  return /iPhone|iPad|iPod|MicroMessenger/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function dimensionsAtScale(config, scale) {
  return { width: Math.round(config.width * scale), height: Math.round(config.height * scale) };
}
function previewDimensions(config) {
  return dimensionsAtScale(config, Math.min(1, PREVIEW_MAX_WIDTH / config.width));
}
function exportDimensions(config) {
  const touchDevice = isMobileSave() || navigator.maxTouchPoints > 0 || /Android/i.test(navigator.userAgent);
  const scale = touchDevice ? Math.min(1, TOUCH_EXPORT_MAX_EDGE / Math.max(config.width, config.height)) : 1;
  return dimensionsAtScale(config, scale);
}
async function loadTemplateImage(config, forPreview = false) {
  const image = new Image();
  image.src = forPreview && config.previewSrc ? config.previewSrc : config.src;
  await image.decode();
  return image;
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

function makeBlob(target) {
  return new Promise((resolve, reject) => target.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成图片')), 'image/png'));
}

async function exportInvitation(name, config) {
  const image = await loadTemplateImage(config);
  let output;
  try {
    output = prepareTemplate(image, config, exportDimensions(config));
    image.src = '';
    drawName(output.getContext('2d'), name, config, output.width / config.width);
    return await makeBlob(output);
  } finally {
    image.src = '';
    if (output) { output.width = 1; output.height = 1; }
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const name = getName();
  if (!cleanTemplate || !name || nameLength(name) > template.maxLength || saving) return;
  saving = true;
  button.disabled = true;
  issuerOptions.disabled = true;
  input.readOnly = true;
  const config = template;
  status.textContent = '正在生成高清图片…';
  try {
    await document.fonts.ready;
    const blob = await exportInvitation(name, config);
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = URL.createObjectURL(blob);
    if (isMobileSave()) {
      document.getElementById('save-image').src = resultURL;
      dialog.showModal();
      status.textContent = '图片已生成，可在弹窗中长按保存。';
    } else {
      const link = document.createElement('a');
      link.href = resultURL;
      link.download = `${config.label}-邀请函-${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      status.textContent = '图片已生成，请查看浏览器的下载文件。';
    }
  } catch (error) {
    status.textContent = '图片暂时未能保存，请重试。';
    console.error('Invitation export failed', error);
  } finally {
    saving = false;
    issuerOptions.disabled = false;
    input.readOnly = false;
    button.disabled = !cleanTemplate || !getName() || nameLength(getName()) > template.maxLength;
  }
});

input.addEventListener('input', event => { if (!event.isComposing) update(); });
input.addEventListener('compositionend', update);
document.getElementById('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
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
