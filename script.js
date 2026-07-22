// version display
const versionEl = document.getElementById('version');
versionEl.textContent = 'v1.5 (自適應二值化+形態學+PSM自選+欄位智慧解析)';

// 1️⃣ 取得後鏡頭
const video = document.getElementById('preview');
const captureBtn = document.getElementById('captureBtn');
const resultDiv = document.getElementById('result');
const downloadLink = document.getElementById('downloadLink');

navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
  .then(stream => { video.srcObject = stream; })
  .catch(err => { alert('無法取得相機：' + err); });

// 2️⃣ 拍照並送到 OCR
captureBtn.addEventListener('click', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // 前處理
  const processed = preprocessImage(canvas);
  const imgData = processed.toDataURL('image/jpeg');

  resultDiv.textContent = 'OCR 辨識中…';
  try {
    // 嘗試多種 PSM
    const psmModes = [6, 4, 3, 11];
    let bestText = '';
    let bestConf = 0;
    for (const psm of psmModes) {
      const { data: { text, confidence } } = await Tesseract.recognize(
        imgData,
        'chi_tra+eng',
        { logger: m => console.log(m), tessedit_pageseg_mode: psm }
      );
      if (confidence > bestConf) {
        bestConf = confidence;
        bestText = text;
      }
    }

    // 後處理清理
    const cleaned = postProcessText(bestText);
    // 欄位解析
    const fields = parseBusinessCardFields(cleaned);

    // 顯示結果
    resultDiv.innerHTML = `
      <strong>辨識信心度: ${bestConf.toFixed(1)}%</strong><br>
      <strong>原始辨識:</strong><pre>${bestText}</pre><hr>
      <strong>清洗後:</strong><pre>${cleaned}</pre><hr>
      <strong>解析欄位:</strong>
      <ul>
        <li>姓名: ${fields.name || '(未偵測)'}</li>
        <li>公司: ${fields.company || '(未偵測)'}</li>
        <li>地址: ${fields.address || '(未偵測)'}</li>
        <li>統編: ${fields.taxId || '(未偵測)'}</li>
        <li>電話: ${fields.phone || '(未偵測)'}</li>
        <li>傳真: ${fields.fax || '(未偵測)'}</li>
        <li>手機: ${fields.mobile || '(未偵測)'}</li>
        <li>Email: ${fields.email || '(未偵測)'}</li>
      </ul>
    `;

    // 產生 vCard
    const vcard = generateVCard(fields);
    const blob = new Blob([vcard], {type: 'text/vcard'});
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = 'contact.vcard';
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '下載 vCard（點擊後在 iOS 上選「開啟 → 通訊錄」）';
  } catch (e) {
    resultDiv.textContent = 'OCR 失敗：' + e;
  }
});

// ---------- 圖像前處理 ----------
function preprocessImage(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const srcCtx = srcCanvas.getContext('2d');
  const imgData = srcCtx.getImageData(0, 0, w, h);
  let data = imgData.data;

  // 1. 轉灰階
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    data[i] = data[i+1] = data[i+2] = gray;
  }

  // 2. 對比增強（線性拉伸）
  // 找出最小和最大灰度值
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range > 0) {
    for (let i = 0; i < data.length; i += 4) {
      let v = data[i];
      v = ((v - min) * 255) / range;
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      data[i] = data[i+1] = data[i+2] = v;
    }
  }

  // 3. 二值化（使用 Otsu 方法）
  // 重新計算直方圖
  const histogram = new Array(256).fill(0);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    histogram[data[i]]++;
    total++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVar = 0;
  let threshold = 0;
  for (let i = 0; i < 256; i++) {
    wB += histogram[i];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += i * histogram[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * Math.pow(mB - mF, 2);
    if (between > maxVar) {
      maxVar = between;
      threshold = i;
    }
  }
  // 應用閾值
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    const bw = v > threshold ? 255 : 0;
    data[i] = data[i+1] = data[i+2] = bw;
  }

  // 4. 形態學操作：先閉運算再開運算（使用 3x3 核）
  // 先膨脹
  const dilated = dilate(data, w, h, 1);
  // 再侵蝕 => 閉運算
  const closed = erode(dilated, w, h, 1);
  // 再侵蝕
  const eroded = erode(closed, w, h, 1);
  // 再膨脹 => 開運算
  const opened = dilate(eroded, w, h, 1);

  // 5. 自動裁切文字區域（基於投影）
  const cropped = autoCrop(opened, w, h);
  const finalData = cropped ? cropped.data : opened;
  const finalW = cropped ? cropped.w : w;
  const finalH = cropped ? cropped.h : h;

  // 建立結果 canvas
  const resCanvas = document.createElement('canvas');
  resCanvas.width = finalW;
  resCanvas.height = finalH;
  const resCtx = resCanvas.getContext('2d');
  const outImgData = resCtx.createImageData(finalW, finalH);
  outImgData.data.set(new Uint8ClampedArray(finalData));
  resCtx.putImageData(outImgData, 0, 0);
  return resCanvas;
}

function dilate(data, w, h, radius) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let max = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            const idx = (ny * w + nx) * 4;
            const val = data[idx]; // 灰階圖取 R 分量
            if (val > max) max = val;
          }
        }
      }
      const idx = (y * w + x) * 4;
      out[idx] = out[idx+1] = out[idx+2] = max;
      out[idx+3] = 255;
    }
  }
  return out;
}

function erode(data, w, h, radius) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let min = 255;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            const idx = (ny * w + nx) * 4;
            const val = data[idx];
            if (val < min) min = val;
          }
        }
      }
      const idx = (y * w + x) * 4;
      out[idx] = out[idx+1] = out[idx+2] = min;
      out[idx+3] = 255;
    }
  }
  return out;
}

function autoCrop(data, w, h) {
  // 水平投影找上下邊界
  const hProj = new Uint32Array(h);
  const vProj = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y*w*4 + x*4] === 0) { // 黑色 pixel
        hProj[y]++;
        vProj[x]++;
      }
    }
  }
  const threshold = Math.max(1, Math.max(...hProj) * 0.02);
  let top = 0, bottom = h-1, left = 0, right = w-1;
  while (top < h && hProj[top] < threshold) top++;
  while (bottom > top && hProj[bottom] < threshold) bottom--;
  while (left < w && vProj[left] < threshold) left++;
  while (right > left && vProj[right] < threshold) right--;
  const pad = 10;
  top = Math.max(0, top - pad);
  bottom = Math.min(h-1, bottom + pad);
  left = Math.max(0, left - pad);
  right = Math.min(w-1, right + pad);
  if (bottom <= top || right <= left) return null;
  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  const crop = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = ((top + y) * w + (left + x)) * 4;
      const dstIdx = (y * cropW + x) * 4;
      crop[dstIdx] = data[srcIdx];
      crop[dstIdx+1] = data[srcIdx+1];
      crop[dstIdx+2] = data[srcIdx+2];
      crop[dstIdx+3] = data[srcIdx+3];
    }
  }
  return { data: crop, w: cropW, h: cropH };
}

// ---------- 後處理文字 ----------
function postProcessText(text) {
  return text
    .replace(/[￥§¶•·◆◇■□★☆♪♫]/g, '')
    .replace(/[｜│┃║]/g, '|')
    .replace(/[─━┄┅┈┉]/g, '-')
    .replace(/[（）]/g, m => m === '（' ? '(' : ')')
    .replace(/[［］【】]/g, m => /[［【]/.test(m) ? '[' : ']')
    .replace(/[。]/g, '.')
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[；]/g, ';')
    .replace(/[？]/g, '?')
    .replace(/[！]/g, '!')
    .replace(/[“”]/g, '\"')
    .replace(/[‘’]/g, "'")
    .replace(/\\s+/g, ' ')
    .split('\\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && /[A-Za-z0-9\\u4e00-\\u9fff]/.test(l))
    .join('\\n');
}

// ---------- 名片欄位解析 ----------
function parseBusinessCardFields(text) {
  const lines = text.split('\\n');
  let name = lines[0] || '';
  let company = '';
  let address = '';
  let taxId = '';
  let phone = '';
  let fax = '';
  let mobile = '';
  let email = '';

  // 合併可能被切斷的地址行
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^(地址|Address|Addr)[：:\\s]*/.test(lines[i]) && lines[i+1] && !/^(電話|傳真|手機|Email|統編)/.test(lines[i+1])) {
      lines[i] += ' ' + lines[i+1];
      lines.splice(i+1, 1);
      i--;
    }
  }

  const fullText = lines.join('\\n');

  // 名稱：第一行
  name = lines[0] || '';

  // 公司：包含關鍵字的行
  for (const line of lines) {
    if (/興聯|科技|公司|Corp|Ltd|Inc|股份|有限/.test(line)) {
      company = line;
      break;
    }
  }

  // 地址：包含路、號、樓、區、市等
  for (const line of lines) {
    if (/[路街道巷弄]|[號樓層室]|[區市村里]|[鎮鄉]/g.test(line) && !/電話|傳真|手機|Email|統編/.test(line)) {
      address = line;
      break;
    }
  }

  // 統編：8位數字
  const taxMatch = fullText.match(/\\b\\d{8}\\b/);
  if (taxMatch) taxId = taxMatch[0];

  // 電話：包含 電話 或 Tel 或 886 + 區號
  const phoneMatch = fullText.match(/(?:電話|Tel|Phone)[：:\\s]*[\\d\\s\\-#]+/);
  if (phoneMatch) phone = phoneMatch[0].replace(/^[^\\d]+/, '');
  else {
    const alt = fullText.match(/886\\s*\\d{2,4}[\\s\\-]?\\d{6,8}/);
    if (alt) phone = alt[0];
  }

  // 傳真：包含 傳真 或 Fax
  const faxMatch = fullText.match(/(?:傳真|Fax)[：:\\s]*[\\d\\s\\-]+/);
  if (faxMatch) fax = faxMatch[0].replace(/^[^\\d]+/, '');

  // 手機：包含 手機 或 Mobile 或 886 9xxxxxxx
  const mobileMatch = fullText.match(/(?:手機|Mobile|Cell)[：:\\s]*[\\d\\s\\-]+/);
  if (mobileMatch) mobile = mobileMatch[0].replace(/^[^\\d]+/, '');
  else {
    const alt = fullText.match(/886\\s*9\\d{8}/);
    if (alt) mobile = alt[0];
  }

  // Email
  const emailMatch = fullText.match(/[\\w\\.-]+@[\\w\\.-]+\\.[\\w]{2,}/);
  if (emailMatch) email = emailMatch[0];

  return { name, company, address, taxId, phone, fax, mobile, email };
}

// ---------- 產生 vCard ----------
function generateVCard(f) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${f.name}`,
    `ORG:${f.company}`,
    f.address ? `ADR;TYPE=WORK:;;${f.address}` : '',
    f.taxId ? `NOTE:統一編號 ${f.taxId}` : '',
    f.phone ? `TEL;TYPE=WORK,VOICE:${f.phone.replace(/[^0-9+#]/g, '')}` : '',
    f.fax ? `TEL;TYPE=FAX:${f.fax.replace(/[^0-9+]/g, '')}` : '',
    f.mobile ? `TEL;TYPE=CELL:${f.mobile.replace(/[^0-9+]/g, '')}` : '',
    f.email ? `EMAIL:${f.email}` : '',
    'END:VCARD'
  ].filter(line => line !== '');
  return lines.join('\\r\\n');
}