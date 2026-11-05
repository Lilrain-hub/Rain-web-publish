/* Full-raster export: independent of DOM layout, scroll position and device DPR. */
(function () {
  'use strict';
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  function deadline(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]).finally(() => clearTimeout(timer));
  }
  function mobile() {
    return /Android|iPhone|iPad|iPod|MicroMessenger|wxwork|WeCom/i.test(navigator.userAgent)
      || navigator.maxTouchPoints > 0;
  }
  function webview() { return /MicroMessenger|wxwork|WeCom/i.test(navigator.userAgent); }
  function sizeOf(image) {
    return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
  }
  async function loadImage(src) {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    try {
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('邀请函图片加载失败，请检查网络后重试。'));
      });
      loaded.catch(() => {});
      image.src = src;
      // decode() also waits for an already cached image. Older WebViews use onload.
      if (typeof image.decode === 'function') {
        await deadline(image.decode(), 25000, '图片加载超时，请检查网络后重试。');
      } else {
        await deadline(loaded, 25000, '图片加载超时，请检查网络后重试。');
      }
      const size = sizeOf(image);
      if (!size.width || !size.height) throw new Error('底图尺寸无效，请刷新后重试。');
      image.onload = image.onerror = null;
      return image;
    } catch (error) {
      image.onload = image.onerror = null;
      image.src = '';
      throw error;
    }
  }
  function createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器可用内存不足，请关闭其他页面后重试。');
    return { canvas, context };
  }
  function dimensions(config, source, maxEdge, maxPixels) {
    const scale = Math.min(1, source.width / config.width, source.height / config.height,
      maxEdge / Math.max(config.width, config.height), Math.sqrt(maxPixels / (config.width * config.height)));
    return { width: Math.max(1, Math.floor(config.width * scale)), height: Math.max(1, Math.floor(config.height * scale)) };
  }
  const markers = [
    [.08, .02], [.5, .25], [.92, .5], [.08, .76], [.5, .91], [.92, .985],
  ];
  function pixelMarkers(context, width, height) {
    return markers.map(([x, y]) => {
      const px = Math.min(width - 1, Math.floor(width * x));
      const py = Math.min(height - 1, Math.floor(height * y));
      return { x: px, y: py, rgba: Array.from(context.getImageData(px, py, 1, 1).data) };
    });
  }
  async function render(image, config, dimensions, finish) {
    const { width, height } = dimensions;
    const { canvas, context } = createCanvas(width, height);
    const source = sizeOf(image);
    // One bounded 256-row scratch strip, composed onto a bounded full image.
    const scratch = createCanvas(width, Math.min(256, height));
    try {
      for (let y = 0; y < height; y += 256) {
        const rows = Math.min(256, height - y);
        scratch.context.clearRect(0, 0, width, scratch.canvas.height);
        const sourceTop = y * source.height / height;
        const sourceBottom = (y + rows) * source.height / height;
        scratch.context.drawImage(image, 0, sourceTop, source.width, sourceBottom - sourceTop, 0, 0, width, rows);
        // getImageData forces rasterization before any backing image is released.
        const probe = scratch.context.getImageData(Math.floor(width / 2), Math.floor(rows / 2), 1, 1).data;
        if (probe[3] < 240) throw new Error('长图未完整绘制，正在尝试较低内存的导出方式。');
        context.drawImage(scratch.canvas, 0, 0, width, rows, 0, y, width, rows);
        if ((y / 256) % 4 === 3) await pause();
      }
      finish(context, dimensions);
      const samples = pixelMarkers(context, width, height);
      if (samples.some(sample => sample.rgba[3] < 240)) throw new Error('长图包含空白区域，请重试。');
      return { canvas, samples };
    } catch (error) {
      canvas.width = canvas.height = 1;
      throw error;
    } finally { scratch.canvas.width = scratch.canvas.height = 1; }
  }
  function encode(canvas, type) {
    return deadline(new Promise((resolve, reject) => {
      try {
        canvas.toBlob(blob => {
          if (!blob || !blob.size) reject(new Error('图片编码失败，正在尝试备用格式。'));
          else resolve(blob);
        }, type, type === 'image/jpeg' ? .96 : undefined);
      } catch (error) { reject(error); }
    }), 25000, '图片生成超时，请关闭其他页面后重试。');
  }
  async function validateBlob(blob, dimensions, samples) {
    const url = URL.createObjectURL(blob);
    let image;
    let probe;
    try {
      image = await loadImage(url);
      const actual = sizeOf(image);
      if (actual.width !== dimensions.width || actual.height !== dimensions.height) {
        throw new Error('图片尺寸不完整，正在尝试备用导出方式。');
      }
      probe = createCanvas(1, 1);
      const tolerance = blob.type === 'image/jpeg' ? 55 : 12;
      for (const sample of samples) {
        probe.context.clearRect(0, 0, 1, 1);
        probe.context.drawImage(image, sample.x, sample.y, 1, 1, 0, 0, 1, 1);
        const actualPixel = probe.context.getImageData(0, 0, 1, 1).data;
        if (actualPixel[3] < 240 || sample.rgba.some((value, channel) => Math.abs(value - actualPixel[channel]) > tolerance)) {
          throw new Error('导出图片的正文或底部不完整，正在重新生成。');
        }
      }
    } finally {
      if (probe) probe.canvas.width = probe.canvas.height = 1;
      if (image) image.src = '';
      URL.revokeObjectURL(url);
    }
  }
  async function create(config, finish, onProgress) {
    const onPhone = mobile();
    // Mobile reuses the already shipped complete, pre-scaled poster, avoiding
    // a 109 MB decoded original plus several equally large canvas surfaces.
    const image = await loadImage(onPhone && config.previewSrc ? config.previewSrc : config.src);
    const source = sizeOf(image);
    if (Math.abs(source.width / source.height - config.width / config.height) > .002) {
      image.src = '';
      throw new Error('底图比例已改变，请更新模板配置后重试。');
    }
    const attempts = onPhone
      ? [[2560, 3000000, 'image/png'], [2048, 2000000, 'image/png'], [2048, 2000000, 'image/jpeg']]
      : [[8192, 32000000, 'image/png'], [4096, 8000000, 'image/png'], [4096, 8000000, 'image/jpeg']];
    let lastError;
    try {
      if (document.fonts && document.fonts.ready) {
        await deadline(document.fonts.ready, 20000, '字体加载超时，请刷新页面后重试。');
      }
      for (let index = 0; index < attempts.length; index++) {
        let output;
        try {
          onProgress(index ? '正在使用较低内存的方式重新生成完整图片…' : '正在生成完整邀请函…');
          const [edge, pixels, type] = attempts[index];
          const dimensions = dimensionsForAttempt(config, source, edge, pixels);
          output = await render(image, config, dimensions, finish);
          const blob = await encode(output.canvas, type);
          // Decode the ACTUAL encoded image and inspect header/body/footer pixels.
          await validateBlob(blob, dimensions, output.samples);
          return { blob, ...dimensions, reduced: index > 0, onPhone, format: blob.type === 'image/jpeg' ? 'JPEG' : 'PNG' };
        } catch (error) {
          if (error.name === 'SecurityError') throw new Error('底图不允许导出，请使用本站提供的模板图片。');
          lastError = error;
        } finally {
          if (output) output.canvas.width = output.canvas.height = 1;
        }
        await pause();
      }
      throw new Error('完整图片生成失败。请关闭其他页面后点击重试，或在系统浏览器中打开。' + (lastError ? ' ' + lastError.message : ''));
    } finally {
      // Hold the source until encoding AND encoded-image verification finish.
      image.src = '';
    }
  }
  function dimensionsForAttempt(config, source, edge, pixels) { return dimensions(config, source, edge, pixels); }
  function dataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('完整图片预览失败，请点击重试。'));
      reader.readAsDataURL(blob);
    });
  }
  window.InvitationExport = { create, loadImage, mobile, webview, dataURL, deadline };
})();
