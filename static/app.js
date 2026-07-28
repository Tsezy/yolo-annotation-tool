const $ = (selector) => document.querySelector(selector);
let project = null;
let currentIndex = -1;
let boxes = [];
let selected = -1;
let drawing = null;
let resizing = null;
let moving = null;
let hoverIndex = -1;
let popoverIndex = -1;
let popoverHideTimer = null;
let guidePoint = null;
let isNavigating = false;
let aiCancelRequested = false;
let aiAbortController = null;
let isConfirmingAi = false;
let image = new Image();
let scale = 1;
let saveTimer = null;

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

function toast(message) {
  const el = $('#toast');
  el.querySelector('span').textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2400);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({ ok: false, error: '服务器返回了无效响应' }));
  if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function createProject(name = '默认项目', classes = ['人员', '车辆']) {
  const data = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, classes })
  });
  return data.project;
}

async function init() {
  applyTheme(localStorage.getItem('yolo-theme') || 'dark');
  const [projectsData, modelsData] = await Promise.all([api('/api/projects'), api('/api/models')]);
  renderModels(modelsData.models);
  if (projectsData.projects.length) {
    await openProject(projectsData.projects[0].id);
  } else {
    project = await createProject();
    currentIndex = -1;
    renderAll();
    showEmptyState();
  }
}

async function openProject(id) {
  project = (await api(`/api/projects/${id}`)).project;
  currentIndex = project.images.length ? 0 : -1;
  renderAll();
  if (currentIndex >= 0) loadCurrent(); else showEmptyState();
}

function renderModels(models) {
  $('#modelName').innerHTML = models.length ? models.map(model =>
    `<option value="${escapeHtml(model.value)}">${escapeHtml(model.label)}</option>`
  ).join('') : '<option value="">未检测到本地模型</option>';
  $('#modelName').disabled = models.length === 0;
}

function renderAll() {
  if (!project) return;
  $('#projectTitle').textContent = project.name;
  updateDatasetMetrics();
  renderClasses();
  renderList();
}

function updateDatasetMetrics() {
  if (!project) return;
  $('#imageCount').textContent = project.images.length;
  $('#annotatedCount').textContent = project.images.filter(item => (project.annotations[item.id] || []).length > 0).length;
  const pendingCount = project.images.filter(item => item.review_status === 'ai_pending' && (project.annotations[item.id] || []).length).length;
  $('#pendingAiCount').textContent = pendingCount;
  $('#cancelPendingAiBtn').hidden = pendingCount === 0;
  $('#cancelPendingAiBtn').title = `撤销全部待确认的 AI 标注（${pendingCount} 张图片）`;
  $('#dropZone').classList.toggle('is-hidden', project.images.length > 0);
}

function renderClasses() {
  const previous = $('#classSelect').value;
  $('#classSelect').innerHTML = project.classes.length ? project.classes.map((name, index) =>
    `<option value="${index}">${index} · ${escapeHtml(name)}</option>`
  ).join('') : '<option value="">请先添加标签</option>';
  $('#classSelect').disabled = project.classes.length === 0;
  if ([...$('#classSelect').options].some(option => option.value === previous)) $('#classSelect').value = previous;
  renderCategoryManager();
}

function renderCategoryManager() {
  const usage = project.classes.map((_, classId) => project.images.reduce(
    (total, item) => total + (project.annotations[item.id] || []).filter(box => box.class_id === classId).length, 0
  ));
  $('#categoryList').innerHTML = project.classes.length ? project.classes.map((name, index) => `
    <div class="category-item">
      <span class="category-swatch" style="--category-color:${boxColor(index)}"></span>
      <span class="category-index">${String(index + 1).padStart(2, '0')}</span>
      <span class="category-name" data-class-id="${index}" title="双击修改标签">${escapeHtml(name)}</span><button class="category-edit" data-class-id="${index}" title="修改标签"><svg><use href="#i-pencil"/></svg></button>
      <span class="category-usage">${usage[index]} 个标注</span>
      <button class="category-delete" data-class-id="${index}" ${usage[index] ? 'disabled' : ''} title="${usage[index] ? '该标签正在使用中' : '删除标签'}"><svg><use href="#i-x"/></svg></button>
    </div>`).join('') : '<div class="category-empty">尚未添加标签</div>';
  document.querySelectorAll('.category-delete').forEach(button => button.addEventListener('click', () => removeClass(Number(button.dataset.classId))));
  document.querySelectorAll('.category-edit').forEach(button => button.addEventListener('click', () => beginRenameClass(Number(button.dataset.classId))));
  document.querySelectorAll('.category-name').forEach(name => name.addEventListener('dblclick', () => beginRenameClass(Number(name.dataset.classId))));
}

function beginRenameClass(classId) {
  const name = document.querySelector(`.category-name[data-class-id="${classId}"]`);
  const item = name?.closest('.category-item');
  if (!item || item.classList.contains('is-editing')) return;
  item.classList.add('is-editing');
  const original = project.classes[classId];
  name.innerHTML = `<input class="category-name-input" value="${escapeHtml(original)}" maxlength="80" aria-label="修改标签名称">`;
  const input = name.querySelector('input');
  input.focus();
  input.select();
  let finished = false;
  const finish = async save => {
    if (finished) return;
    finished = true;
    if (!save) return renderCategoryManager();
    const nextName = input.value.trim();
    if (!nextName) { toast('标签名称不能为空'); return renderCategoryManager(); }
    if (project.classes.some((value, index) => index !== classId && value.toLowerCase() === nextName.toLowerCase())) {
      toast('这个标签已经存在');
      return renderCategoryManager();
    }
    if (nextName === original) return renderCategoryManager();
    try {
      const classes = [...project.classes];
      classes[classId] = nextName;
      project = (await api(`/api/projects/${project.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classes })
      })).project;
      renderClasses();
      draw();
      toast(`标签已修改为“${nextName}”`);
    } catch (error) {
      toast(error.message);
      renderCategoryManager();
    }
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderList() {
  $('#imageList').innerHTML = project.images.map((item, index) => {
    const count = (project.annotations[item.id] || []).length;
    const sources = (project.annotations[item.id] || []).map(box => box.source);
    const pendingAi = count > 0 && (item.review_status === 'ai_pending' || (!item.review_status && sources.length && sources.every(source => source === 'ai')));
    const confirmed = count > 0 && !pendingAi;
    return `<div class="image-item ${index === currentIndex ? 'active' : ''} ${pendingAi ? 'ai-pending' : confirmed ? 'confirmed' : ''}" data-index="${index}">
      <img class="thumb" src="/api/projects/${project.id}/images/${item.id}" alt="">
      <span class="image-meta"><b>${escapeHtml(item.name)}</b><small>${item.width}×${item.height} · ${count} 个框</small></span>
      <button class="annotation-status ${pendingAi ? 'ai-pending' : confirmed ? 'confirmed' : ''}" data-image-id="${item.id}" ${count ? '' : 'disabled'} title="${pendingAi ? 'AI 标注待确认，点击确认' : confirmed ? '标注已确认' : '尚未标注'}"><svg><use href="#i-check"/></svg></button>
      <button class="image-delete" data-image-id="${item.id}" title="删除图片"><svg><use href="#i-trash"/></svg></button>
    </div>`;
  }).join('');
  document.querySelectorAll('.image-item').forEach(item => {
    item.addEventListener('click', async event => {
      if (event.target.closest('.image-delete')) return;
      await saveNow();
      currentIndex = Number(item.dataset.index);
      renderList();
      loadCurrent();
    });
  });
  document.querySelectorAll('.image-delete').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    requestDeleteImage(button.dataset.imageId);
  }));
  document.querySelectorAll('.annotation-status.ai-pending').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    try {
      project = (await api(`/api/projects/${project.id}/images/${button.dataset.imageId}/confirm`, { method: 'POST' })).project;
      renderAll();
      toast('AI 标注已确认');
    } catch (error) { toast(error.message); }
  }));
  updateNavigationState();
  requestAnimationFrame(() => {
    const activeItem = $('#imageList .image-item.active');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
}

function updateNavigationState() {
  const hasImages = Boolean(project?.images.length);
  $('#prevBtn').disabled = !hasImages || currentIndex <= 0;
  $('#nextBtn').disabled = !hasImages || currentIndex >= project.images.length - 1;
}

function showEmptyState() {
  hideBoxPopover();
  guidePoint = null;
  canvas.style.display = 'none';
  $('#emptyState').style.display = 'flex';
  $('#currentFile').textContent = '尚未选择图片';
  $('#boxCount').textContent = '0 个目标';
}

function loadCurrent() {
  if (!project || currentIndex < 0 || !project.images[currentIndex]) return showEmptyState();
  const item = project.images[currentIndex];
  boxes = structuredClone(project.annotations[item.id] || []);
  selected = -1;
  guidePoint = null;
  hideBoxPopover();
  image.onload = resizeCanvas;
  image.onerror = () => toast('图片加载失败，请尝试重新导入');
  image.src = `/api/projects/${project.id}/images/${item.id}?v=${Date.now()}`;
  $('#emptyState').style.display = 'none';
  canvas.style.display = 'block';
  $('#currentFile').textContent = item.name;
  updateBoxCount();
}

function resizeCanvas() {
  const stage = $('#canvasStage');
  const maxWidth = Math.max(100, stage.clientWidth - 32);
  const maxHeight = Math.max(100, stage.clientHeight - 32);
  scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  draw();
}

function boxColor(index) {
  const colors = ['#4b8cff', '#ff6473', '#36b77b', '#e7ad34', '#a66cff', '#19aaa4', '#f0783e'];
  return colors[index % colors.length];
}

function draw() {
  if (!image.naturalWidth) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  boxes.forEach((box, index) => {
    const x = box.x * scale, y = box.y * scale, w = box.w * scale, h = box.h * scale;
    const color = boxColor(box.class_id);
    ctx.strokeStyle = color;
    ctx.lineWidth = index === selected ? 3 : 2;
    ctx.strokeRect(x, y, w, h);
    const isPendingAi = project.images[currentIndex]?.review_status === 'ai_pending' && box.source !== 'manual';
    const confidence = isPendingAi && box.confidence != null ? ` ${Math.round(box.confidence * 100)}%` : '';
    const label = `${project.classes[box.class_id] || '未知'}${confidence}`;
    ctx.font = '12px sans-serif';
    const labelWidth = ctx.measureText(label).width + 10;
    ctx.fillStyle = color;
    ctx.fillRect(x, Math.max(0, y - 20), labelWidth, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 5, Math.max(14, y - 6));
    if (index === selected) drawResizeHandles(x, y, w, h, color);
  });
  if (drawing) {
    ctx.save();
    ctx.setLineDash([9, 6]);
    ctx.strokeStyle = boxColor(Number($('#classSelect').value));
    ctx.lineWidth = 3.5;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 8;
    ctx.strokeRect(drawing.x, drawing.y, drawing.w, drawing.h);
    ctx.restore();
  }
  if (guidePoint) drawCrosshairGuide(guidePoint.x, guidePoint.y);
}

function drawCrosshairGuide(x, y) {
  ctx.save();
  ctx.setLineDash([7, 7]);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = 'rgba(184, 255, 82, 0.72)';
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(canvas.width, y);
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(184, 255, 82, 0.95)';
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawResizeHandles(x, y, w, h, color) {
  const size = 9;
  ctx.save();
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel-solid').trim() || '#121517';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const point of [
    [x, y], [x + w / 2, y], [x + w, y],
    [x + w, y + h / 2], [x + w, y + h],
    [x + w / 2, y + h], [x, y + h], [x, y + h / 2]
  ]) {
    ctx.fillRect(point[0] - size / 2, point[1] - size / 2, size, size);
    ctx.strokeRect(point[0] - size / 2, point[1] - size / 2, size, size);
  }
  ctx.restore();
}

function boxAtPoint(point) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const box = boxes[i], x = box.x * scale, y = box.y * scale, w = box.w * scale, h = box.h * scale;
    if (point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h) return i;
  }
  return -1;
}

function resizeHandleAtPoint(point) {
  if (selected < 0) return null;
  const box = boxes[selected], x = box.x * scale, y = box.y * scale, w = box.w * scale, h = box.h * scale;
  const handles = [
    { name: 'nw', x, y },
    { name: 'n', x: x + w / 2, y },
    { name: 'ne', x: x + w, y },
    { name: 'e', x: x + w, y: y + h / 2 },
    { name: 'se', x: x + w, y: y + h },
    { name: 's', x: x + w / 2, y: y + h },
    { name: 'sw', x, y: y + h },
    { name: 'w', x, y: y + h / 2 },
  ];
  return handles.find(handle => Math.abs(point.x - handle.x) <= 10 && Math.abs(point.y - handle.y) <= 10) || null;
}

function resizeCursor(name) {
  if (name === 'n' || name === 's') return 'ns-resize';
  if (name === 'e' || name === 'w') return 'ew-resize';
  if (name === 'ne' || name === 'sw') return 'nesw-resize';
  return 'nwse-resize';
}

function showBoxPopover(index) {
  if (index < 0 || !boxes[index]) return hideBoxPopover();
  clearTimeout(popoverHideTimer);
  popoverIndex = index;
  const box = boxes[index];
  const select = $('#boxLabelSelect');
  select.innerHTML = project.classes.map((name, classIndex) => `<option value="${classIndex}">${escapeHtml(name)}</option>`).join('');
  select.value = String(box.class_id);
  const popover = $('#boxPopover');
  popover.hidden = false;
  const left = canvas.offsetLeft + (box.x + box.w / 2) * scale;
  const topEdge = canvas.offsetTop + box.y * scale;
  popover.style.left = `${Math.max(88, Math.min($('#canvasStage').clientWidth - 88, left))}px`;
  popover.style.top = `${Math.max(12, topEdge - 10)}px`;
}

function hideBoxPopover(delay = 0) {
  clearTimeout(popoverHideTimer);
  popoverHideTimer = setTimeout(() => {
    $('#boxPopover').hidden = true;
    popoverIndex = -1;
  }, delay);
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
}

canvas.addEventListener('mousedown', event => {
  if (!project.classes.length) { toast('请先添加标签再进行标注'); return; }
  const point = pointerPosition(event);
  const handle = resizeHandleAtPoint(point);
  if (handle) {
    const box = boxes[selected];
    resizing = { index: selected, name: handle.name,
      left: box.x * scale, top: box.y * scale,
      right: (box.x + box.w) * scale, bottom: (box.y + box.h) * scale };
    hideBoxPopover();
    return;
  }
  const hit = boxAtPoint(point);
  if (hit >= 0) {
    selected = hit;
    const box = boxes[hit];
    moving = { index: hit, startX: point.x, startY: point.y, originX: box.x, originY: box.y,
      armedAt: performance.now() + 180, moved: false };
    showBoxPopover(hit);
    draw();
    return;
  }
  selected = -1;
  hideBoxPopover();
  drawing = { startX: point.x, startY: point.y, x: point.x, y: point.y, w: 0, h: 0 };
});

canvas.addEventListener('mousemove', event => {
  const point = pointerPosition(event);
  guidePoint = point;
  if (moving) {
    if (performance.now() < moving.armedAt) {
      canvas.style.cursor = 'grab';
      return;
    }
    const box = boxes[moving.index];
    const dx = (point.x - moving.startX) / scale;
    const dy = (point.y - moving.startY) / scale;
    box.x = Math.max(0, Math.min(Math.max(0, image.naturalWidth - box.w), moving.originX + dx));
    box.y = Math.max(0, Math.min(Math.max(0, image.naturalHeight - box.h), moving.originY + dy));
    box.confidence = null;
    box.source = 'manual';
    moving.moved = true;
    canvas.style.cursor = 'grabbing';
    hideBoxPopover();
    draw();
    return;
  }
  if (resizing) {
    const minimum = 6;
    let { left, top, right, bottom } = resizing;
    if (resizing.name.includes('w')) left = Math.max(0, Math.min(point.x, right - minimum));
    if (resizing.name.includes('e')) right = Math.min(canvas.width, Math.max(point.x, left + minimum));
    if (resizing.name.includes('n')) top = Math.max(0, Math.min(point.y, bottom - minimum));
    if (resizing.name.includes('s')) bottom = Math.min(canvas.height, Math.max(point.y, top + minimum));
    boxes[resizing.index] = { ...boxes[resizing.index], x: left / scale, y: top / scale,
      w: (right - left) / scale, h: (bottom - top) / scale, confidence: null, source: 'manual' };
    canvas.style.cursor = resizeCursor(resizing.name);
    draw();
    return;
  }
  if (!drawing) {
    const handle = resizeHandleAtPoint(point);
    const hit = boxAtPoint(point);
    canvas.style.cursor = handle ? resizeCursor(handle.name) : hit >= 0 ? 'pointer' : 'crosshair';
    if (hit !== hoverIndex) {
      hoverIndex = hit;
      if (hit >= 0) showBoxPopover(hit); else hideBoxPopover(140);
    }
    draw();
    return;
  }
  drawing.x = Math.min(drawing.startX, point.x);
  drawing.y = Math.min(drawing.startY, point.y);
  drawing.w = Math.abs(point.x - drawing.startX);
  drawing.h = Math.abs(point.y - drawing.startY);
  draw();
});

window.addEventListener('mouseup', () => {
  if (moving) {
    const moved = moving.moved;
    moving = null;
    canvas.style.cursor = 'crosshair';
    if (moved) changed();
    if (selected >= 0) showBoxPopover(selected);
    draw();
    return;
  }
  if (resizing) {
    resizing = null;
    canvas.style.cursor = 'crosshair';
    changed();
    showBoxPopover(selected);
    draw();
    return;
  }
  if (!drawing) return;
  if (drawing.w > 5 && drawing.h > 5) {
    boxes.push({ class_id: Number($('#classSelect').value), x: drawing.x / scale, y: drawing.y / scale, w: drawing.w / scale, h: drawing.h / scale, source: 'manual' });
    selected = boxes.length - 1;
    changed();
  }
  drawing = null;
  showBoxPopover(selected);
  draw();
});

canvas.addEventListener('mouseenter', event => { guidePoint = pointerPosition(event); draw(); });
canvas.addEventListener('mouseleave', () => { hoverIndex = -1; guidePoint = null; hideBoxPopover(180); draw(); });
$('#boxPopover').addEventListener('mouseenter', () => clearTimeout(popoverHideTimer));
$('#boxPopover').addEventListener('mouseleave', () => hideBoxPopover(180));
$('#boxLabelSelect').addEventListener('change', event => {
  if (popoverIndex < 0 || !boxes[popoverIndex]) return;
  boxes[popoverIndex].class_id = Number(event.target.value);
  boxes[popoverIndex].confidence = null;
  boxes[popoverIndex].source = 'manual';
  selected = popoverIndex;
  changed();
  draw();
});
$('#popoverDeleteBtn').addEventListener('click', () => {
  if (popoverIndex < 0) return;
  selected = popoverIndex;
  deleteSelected();
  hideBoxPopover();
});

async function confirmCurrentAi() {
  if (isConfirmingAi || !project || currentIndex < 0) return;
  const item = project.images[currentIndex];
  if (!item || item.review_status !== 'ai_pending' || !(project.annotations[item.id] || []).length) return;
  isConfirmingAi = true;
  try {
    project = (await api(`/api/projects/${project.id}/images/${item.id}/confirm`, { method: 'POST' })).project;
    boxes = structuredClone(project.annotations[item.id] || []);
    renderAll();
    draw();
    toast('当前图片的 AI 标注已确认');
  } catch (error) {
    toast(error.message);
  } finally {
    isConfirmingAi = false;
  }
}

window.addEventListener('keydown', event => {
  const active = document.activeElement;
  const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName) || active?.isContentEditable;
  const dialogOpen = Boolean(document.querySelector('dialog[open]'));
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected >= 0 && !isEditing && !dialogOpen) deleteSelected();
  if (!isEditing && !dialogOpen && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === 'a') { event.preventDefault(); move(-1); }
    if (key === 'd') { event.preventDefault(); move(1); }
    if (key === 's') { event.preventDefault(); confirmCurrentAi(); }
  }
});

function updateBoxCount() { $('#boxCount').textContent = `${boxes.length} 个目标`; }
function changed() {
  updateBoxCount();
  if (project && currentIndex >= 0 && project.images[currentIndex]) {
    const currentItem = project.images[currentIndex];
    project.annotations[currentItem.id] = structuredClone(boxes);
    if (boxes.some(box => box.source === 'manual')) currentItem.review_status = 'confirmed';
    else if (!boxes.length) delete currentItem.review_status;
    updateDatasetMetrics();
    renderCategoryManager();
  }
  $('#saveState').textContent = '保存中';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 450);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!project || currentIndex < 0 || !project.images[currentIndex]) return;
  const id = project.images[currentIndex].id;
  await api(`/api/projects/${project.id}/annotations/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boxes }) });
  project.annotations[id] = structuredClone(boxes);
  const currentItem = project.images[currentIndex];
  if (boxes.some(box => box.source === 'manual')) currentItem.review_status = 'confirmed';
  else if (!boxes.length) delete currentItem.review_status;
  updateDatasetMetrics();
  renderCategoryManager();
  $('#saveState').textContent = '已保存';
  renderList();
}

function uploadRequest(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      const data = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) resolve(data);
      else reject(new Error(data.error || '上传失败'));
    });
    xhr.addEventListener('error', () => reject(new Error('网络连接中断，上传失败')));
    xhr.send(form);
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter(file => /\.(jpe?g|png|bmp|webp)$/i.test(file.name) || file.type.startsWith('image/'));
  if (!files.length) return toast('没有找到支持的图片文件');
  if (!project) project = await createProject();
  const form = new FormData();
  files.forEach(file => form.append('images', file, file.name));
  const dialog = $('#uploadDialog');
  $('#uploadStatus').textContent = `正在传输 ${files.length} 个文件`;
  $('#uploadDetail').textContent = `0 B / ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}`;
  $('#uploadPercent').textContent = '0%';
  $('#uploadProgress').style.width = '0%';
  dialog.showModal();
  try {
    const data = await uploadRequest(`/api/projects/${project.id}/images`, form, (loaded, total) => {
      const percent = Math.min(99, Math.round(loaded / total * 100));
      $('#uploadProgress').style.width = `${percent}%`;
      $('#uploadPercent').textContent = `${percent}%`;
      $('#uploadDetail').textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
      if (loaded === total) $('#uploadStatus').textContent = '传输完成，正在校验重复内容与图像信息';
    });
    $('#uploadProgress').style.width = '100%';
    $('#uploadPercent').textContent = '100%';
    project = data.project;
    if (currentIndex < 0 && project.images.length) currentIndex = 0;
    renderAll();
    if (currentIndex >= 0) loadCurrent();
    const duplicateCount = data.duplicates?.length || 0;
    $('#uploadStatus').textContent = duplicateCount ? `导入完成，已智能跳过 ${duplicateCount} 个重复文件` : '所有视觉样本导入完成';
    await new Promise(resolve => setTimeout(resolve, 650));
    dialog.close();
    toast(duplicateCount ? `新增 ${data.added.length} 张，跳过 ${duplicateCount} 张重复图片` : `成功导入 ${data.added.length} 张图片`);
  } catch (error) {
    dialog.close();
    toast(error.message);
  } finally {
    $('#fileInput').value = '';
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 字节';
  const units = ['字节', '千字节', '兆字节', '吉字节'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function chooseFiles() { $('#fileInput').click(); }
$('#uploadBtn').addEventListener('click', chooseFiles);
$('#emptyUploadBtn').addEventListener('click', chooseFiles);
$('#dropZone').addEventListener('click', chooseFiles);
$('#fileInput').addEventListener('change', event => uploadFiles(event.target.files));
['dragenter', 'dragover'].forEach(type => $('#dropZone').addEventListener(type, event => { event.preventDefault(); $('#dropZone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(type => $('#dropZone').addEventListener(type, event => { event.preventDefault(); $('#dropZone').classList.remove('drag'); }));
$('#dropZone').addEventListener('drop', event => uploadFiles(event.dataTransfer.files));

function deleteSelected() { if (selected >= 0) { boxes.splice(selected, 1); selected = -1; hoverIndex = -1; hideBoxPopover(); changed(); draw(); } }
$('#clearBtn').addEventListener('click', () => {
  if (!boxes.length) return toast('当前图片没有标注');
  openConfirm('清空当前标注？', `当前图片的 ${boxes.length} 个标注框将被永久删除。`, async () => {
    boxes = []; selected = -1; changed(); draw(); await saveNow(); toast('当前图片标注已清空');
  });
});

let pendingDelete = null;
function openConfirm(title, text, action) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  pendingDelete = action;
  $('#confirmDialog').showModal();
}

function requestDeleteImage(imageId) {
  const item = project.images.find(value => value.id === imageId);
  if (!item) return;
  openConfirm('删除这张图片？', `“${item.name}”及其全部标注将被永久删除。`, async () => {
    await saveNow();
    const data = await api(`/api/projects/${project.id}/images/${imageId}`, { method: 'DELETE' });
    project = data.project;
    currentIndex = project.images.length ? Math.min(currentIndex, project.images.length - 1) : -1;
    renderAll();
    if (currentIndex >= 0) loadCurrent(); else showEmptyState();
    toast('图片及其标注已删除');
  });
}

$('#deleteAllBtn').addEventListener('click', () => {
  if (!project?.images.length) return toast('当前项目没有图片');
  openConfirm('清空整个项目？', `项目中的 ${project.images.length} 张图片、全部标注和所有标签都将被永久删除。`, async () => {
    await saveNow();
    const data = await api(`/api/projects/${project.id}/images`, { method: 'DELETE' });
    project = data.project; currentIndex = -1; boxes = []; selected = -1;
    renderAll(); showEmptyState(); toast(`已清空 ${data.deleted} 张图片、全部标注和标签`);
  });
});

$('#cancelPendingAiBtn').addEventListener('click', () => {
  const pendingCount = project.images.filter(item => item.review_status === 'ai_pending' && (project.annotations[item.id] || []).length).length;
  if (!pendingCount) return;
  openConfirm('撤销全部待确认标注？', `将移除 ${pendingCount} 张图片中尚未确认的 AI 与目标跟踪标注，手工标注会被保留。`, async () => {
    const data = await api(`/api/projects/${project.id}/annotations/ai-pending`, { method: 'DELETE' });
    project = data.project;
    renderAll();
    if (currentIndex >= 0 && project.images[currentIndex]) loadCurrent();
    toast(`已撤销 ${data.images} 张图片中的 ${data.boxes} 个待确认标注`);
  });
});

$('#confirmActionBtn').addEventListener('click', async event => {
  event.preventDefault();
  const button = $('#confirmActionBtn');
  button.disabled = true;
  try { if (pendingDelete) await pendingDelete(); $('#confirmDialog').close(); }
  catch (error) { toast(error.message); }
  finally { pendingDelete = null; button.disabled = false; }
});

async function move(direction) {
  if (!project?.images.length || isNavigating) return;
  const targetIndex = currentIndex + direction;
  if (targetIndex < 0 || targetIndex >= project.images.length) return;
  isNavigating = true;
  try {
    await saveNow();
    currentIndex = targetIndex;
    renderList();
    loadCurrent();
  } finally {
    isNavigating = false;
  }
}
$('#prevBtn').addEventListener('click', () => move(-1));
$('#nextBtn').addEventListener('click', () => move(1));
window.addEventListener('resize', () => { if (image.complete && image.naturalWidth) resizeCanvas(); });

$('#confidence').addEventListener('input', event => { $('#confidenceText').textContent = Number(event.target.value).toFixed(2); });
const includeAnnotatedInput = $('#includeAnnotated');
const includeAnnotatedSwitch = $('#includeAnnotatedSwitch');
includeAnnotatedSwitch.addEventListener('click', () => {
  includeAnnotatedInput.checked = !includeAnnotatedInput.checked;
  includeAnnotatedSwitch.setAttribute('aria-pressed', String(includeAnnotatedInput.checked));
});
const switchHelp = $('.switch-help');
const switchTooltip = $('#switchTooltip');
function showSwitchTooltip() {
  const rect = switchHelp.getBoundingClientRect();
  switchTooltip.classList.add('visible');
  const width = switchTooltip.offsetWidth;
  const height = switchTooltip.offsetHeight;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
  let top = rect.bottom + 9;
  if (top + height > window.innerHeight - 12) top = rect.top - height - 9;
  switchTooltip.style.left = `${left}px`;
  switchTooltip.style.top = `${Math.max(12, top)}px`;
}
function hideSwitchTooltip() { switchTooltip.classList.remove('visible'); }
switchHelp.addEventListener('mouseenter', showSwitchTooltip);
switchHelp.addEventListener('mouseleave', hideSwitchTooltip);
switchHelp.addEventListener('focus', showSwitchTooltip);
switchHelp.addEventListener('blur', hideSwitchTooltip);
window.addEventListener('scroll', hideSwitchTooltip, true);
async function addClass() {
  const input = $('#newClassInput');
  const name = input.value.trim();
  if (!name) return toast('请输入标签名称');
  if (project.classes.some(value => value.toLowerCase() === name.toLowerCase())) return toast('这个标签已经存在');
  const classes = [...project.classes, name];
  project = (await api(`/api/projects/${project.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classes }) })).project;
  input.value = '';
  renderClasses();
  $('#classSelect').value = String(project.classes.length - 1);
  toast(`已添加标签“${name}”`);
}

async function removeClass(classId) {
  try {
    project = (await api(`/api/projects/${project.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove_class_id: classId }) })).project;
    renderAll();
    if (currentIndex >= 0) loadCurrent();
    toast('标签已删除');
  } catch (error) { toast(error.message); }
}

$('#addClassBtn').addEventListener('click', addClass);
$('#newClassInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addClass(); } });

$('#autoBtn').addEventListener('click', async () => {
  if (!project?.images.length) return toast('请先导入图片');
  if (!$('#modelName').value) return toast('请先把模型文件放入本地模型文件夹');
  await saveNow();
  const button = $('#autoBtn');
  button.disabled = true;
  $('#aiResult').className = 'message';
  $('#aiResult').textContent = '首次运行官方模型时可能需要下载模型权重。';
  const includeAnnotated = $('#includeAnnotated').checked;
  const targets = project.images.filter(item => includeAnnotated || !(project.annotations[item.id] || []).length);
  if (!targets.length) {
    button.disabled = false;
    return toast('没有需要自动标注的图片');
  }
  aiCancelRequested = false;
  const dialog = $('#aiProgressDialog');
  $('#aiProgressBar').style.width = '0%';
  $('#aiProgressPercent').textContent = '0%';
  $('#aiProgressDetail').textContent = `0 / ${targets.length}`;
  $('#aiProgressStatus').textContent = '正在加载模型并准备识别';
  dialog.showModal();
  let processed = 0;
  let generatedBoxes = 0;
  try {
    for (let index = 0; index < targets.length; index++) {
      if (aiCancelRequested) break;
      const item = targets[index];
      $('#aiProgressStatus').textContent = `正在识别：${item.name}`;
      aiAbortController = new AbortController();
      const data = await api(`/api/projects/${project.id}/auto-annotate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: aiAbortController.signal,
        body: JSON.stringify({ model: $('#modelName').value, confidence: Number($('#confidence').value), include_annotated: true, image_ids: [item.id] })
      });
      project = data.project;
      processed += data.processed;
      generatedBoxes += data.boxes;
      const completed = index + 1;
      const percent = Math.round(completed / targets.length * 100);
      $('#aiProgressBar').style.width = `${percent}%`;
      $('#aiProgressPercent').textContent = `${percent}%`;
      $('#aiProgressDetail').textContent = `${completed} / ${targets.length}`;
      renderAll();
    }
    if (aiCancelRequested) {
      project = (await api(`/api/projects/${project.id}`)).project;
      $('#aiResult').textContent = `任务已取消：完成 ${processed} 张，生成 ${generatedBoxes} 个框。`;
      toast('AI 标注任务已取消');
    } else {
      $('#aiProgressStatus').textContent = '智能标注已完成';
      $('#aiResult').textContent = `完成：处理 ${processed} 张，生成 ${generatedBoxes} 个匹配当前标签的框。`;
      await new Promise(resolve => setTimeout(resolve, 450));
    }
    renderAll(); loadCurrent();
  } catch (error) {
    if (error.name === 'AbortError' && aiCancelRequested) {
      project = (await api(`/api/projects/${project.id}`)).project;
      renderAll();
      if (currentIndex >= 0) loadCurrent();
      $('#aiResult').textContent = `任务已取消：完成 ${processed} 张，生成 ${generatedBoxes} 个框。`;
      toast('AI 标注任务已取消');
    } else {
      $('#aiResult').className = 'message error';
      $('#aiResult').textContent = error.message;
    }
  } finally {
    if (dialog.open) dialog.close();
    aiAbortController = null;
    button.disabled = false;
  }
});

function bindTrackRange(inputId, textId, formatter) {
  const input = $(inputId);
  const update = () => $(textId).textContent = formatter(Number(input.value));
  input.addEventListener('input', update);
  update();
}
bindTrackRange('#trackMaxScale', '#trackMaxScaleText', value => `${value}%`);
bindTrackRange('#trackSearchRatio', '#trackSearchRatioText', value => `${value}%`);
bindTrackRange('#trackScaleRange', '#trackScaleRangeText', value => `${value}%`);
bindTrackRange('#trackMatchThreshold', '#trackMatchThresholdText', value => value.toFixed(2));

$('#trackBtn').addEventListener('click', async () => {
  if (!project?.images.length || currentIndex < 0) return toast('请先选择图片');
  if (selected < 0 || !boxes[selected]) return toast('请先点击选中一个标注框');
  if (currentIndex >= project.images.length - 1) return toast('当前已是最后一张图片');
  await saveNow();
  const button = $('#trackBtn');
  const targets = project.images.slice(currentIndex + 1);
  const includeAnnotated = $('#includeAnnotated').checked;
  const useKeyframeCalibration = $('#trackKeyframeCalibration').checked;
  const trackingOptions = {
    scale_limit_enabled: $('#trackScaleLimit').checked,
    max_scale_change: Number($('#trackMaxScale').value) / 100,
    template_refine_enabled: $('#trackTemplateRefine').checked,
    template_search_ratio: Number($('#trackSearchRatio').value) / 100,
    template_scale_range: Number($('#trackScaleRange').value) / 100,
    template_match_threshold: Number($('#trackMatchThreshold').value)
  };
  const dialog = $('#aiProgressDialog');
  button.disabled = true;
  aiCancelRequested = false;
  $('#aiProgressBar').style.width = '0%';
  $('#aiProgressPercent').textContent = '0%';
  $('#aiProgressDetail').textContent = `0 / ${targets.length}`;
  $('#aiProgressStatus').textContent = '正在准备目标跟踪...';
  dialog.querySelector('h2').textContent = '正在跟踪当前目标';
  dialog.showModal();
  let sourceId = project.images[currentIndex].id;
  let movingBox = structuredClone(boxes[selected]);
  let completed = 0;
  try {
    for (const item of targets) {
      if (aiCancelRequested) break;
      const existingBoxes = project.annotations[item.id] || [];
      if (existingBoxes.length && !includeAnnotated) {
        const continuation = useKeyframeCalibration
          ? existingBoxes.find(box => Number(box.class_id) === Number(movingBox.class_id) && box.source === 'manual')
          : null;
        if (continuation) {
          movingBox = structuredClone(continuation);
          sourceId = item.id;
        }
        continue;
      }
      $('#aiProgressStatus').textContent = `正在跟踪：${item.name}`;
      aiAbortController = new AbortController();
      const data = await api(`/api/projects/${project.id}/track-step`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: aiAbortController.signal,
        body: JSON.stringify({ source_image_id: sourceId, target_image_id: item.id, box: movingBox,
          replace: includeAnnotated, ...trackingOptions })
      });
      project = data.project;
      movingBox = data.box;
      sourceId = item.id;
      completed++;
      const percent = Math.round(completed / targets.length * 100);
      $('#aiProgressBar').style.width = `${percent}%`;
      $('#aiProgressPercent').textContent = `${percent}%`;
      $('#aiProgressDetail').textContent = `${completed} / ${targets.length}`;
      renderAll();
    }
    $('#aiResult').className = 'message';
    $('#aiResult').textContent = aiCancelRequested
      ? `跟踪已取消，已传播到 ${completed} 张图片。`
      : `跟踪完成，已生成 ${completed} 个蓝色待确认框。`;
    if (!aiCancelRequested) await new Promise(resolve => setTimeout(resolve, 350));
  } catch (error) {
    if (error.name !== 'AbortError') {
      $('#aiResult').className = 'message error';
      $('#aiResult').textContent = `${error.message}，已完成 ${completed} 张。`;
    }
  } finally {
    if (dialog.open) dialog.close();
    dialog.querySelector('h2').textContent = '正在识别图片';
    aiAbortController = null;
    button.disabled = false;
    renderAll();
    loadCurrent();
  }
});

$('#cancelAiBtn').addEventListener('click', () => {
  aiCancelRequested = true;
  $('#aiProgressStatus').textContent = '将在当前图片识别完成后停止';
  $('#cancelAiBtn').disabled = true;
  setTimeout(() => { $('#cancelAiBtn').disabled = false; }, 500);
});

$('#exportBtn').addEventListener('click', async () => {
  if (!project?.images.length) return toast('没有可导出的图片');
  await saveNow();
  window.location.href = `/api/projects/${project.id}/export?format=${$('#exportFormat').value}`;
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn use').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  $('#themeBtn').title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
}
$('#themeBtn').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('yolo-theme', theme);
  applyTheme(theme);
});

$('#newProjectBtn').addEventListener('click', () => $('#projectDialog').showModal());
$('#createProjectBtn').addEventListener('click', async event => {
  event.preventDefault();
  const classes = $('#initialClasses').value.split('\n').map(value => value.trim()).filter(Boolean);
  project = await createProject($('#projectName').value.trim() || '未命名项目', classes.length ? classes : ['目标']);
  currentIndex = -1; boxes = []; selected = -1;
  $('#projectDialog').close();
  renderAll(); showEmptyState(); toast('新项目已创建');
});

init().catch(error => toast(error.message));
