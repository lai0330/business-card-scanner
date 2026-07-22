// version display
const versionEl = document.getElementById('version');
versionEl.textContent = 'v2.1 (增強前處理：灰階+對比+自適應二值化+形態學+去噪+PSM自選)';

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
    // 嘗試多種 PSM，選擇信心度最高者
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
  let imgData = srcCtx.getImageData(0, 0, w, h);
  let data = imgData.data;

  // 1. 轉灰階 (平均法)
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
    data[i] = data[i+1] = data[i+2] = gray;
  }

  // 2. 對比增強 (拉伸 histogram)
  // 計算直方圖
  const hist = new Array(256).fill(0);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    hist[v]++;
    total++;
  }
  // 累積分布函數
  const cdf = new Array(256);
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += hist[i];
    cdf[i] = sum;
  }
  // 最小非零CDF
  let cdfMin = 0;
  while (cdf[cdfMin] === 0 && cdfMin < 255) cdfMin++;
  // 均衡化
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    const newV = Math.round(((cdf[v] - cdf[cdfMin]) * 255) / (total - cdf[cdfMin]));
    data[i] = data[i+1] = data[i+2] = newV;
  }

  // 3. 自適應二值化 (簡單區域平均法，窗口 15)
  const windowSize = 15;
  const offset = Math.floor(windowSize / 2);
  const binary = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -offset; dy <= offset; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -offset; dx <= offset; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const idx = (ny * w + nx) * 4;
          sum += data[idx];
          count++;
        }
      }
      const mean = sum / count;
      const idx = (y * w + x) * 4;
      binary[y * w + x] = data[idx] > (mean - 10) ? 0 : 255; // 黑字白底
    }
  }
  // 寫回為灰階圖像 (0 黑, 255 白)
  for (let i = 0; i < data.length; i += 4) {
    const v = binary[i/4];
    data[i] = data[i+1] = data[i+2] = v;
  }

  // 4. 形態學操作：先閉運算再開運算 (3x3)
  // 膨脹
  let dilated = dilateBinary(new Uint8ClampedArray(binary), w, h, 1);
  // 侵蝕 => 閉
  let closed = erodeBinary(dilated, w, h, 1);
  // 再侵蝕
  let eroded = erodeBinary(closed, w, h, 1);
  // 再膨脹 => 開
  let opened = dilateBinary(eroded, w, h, 1);
  // 轉回灰階圖像
  for (let i = 0; i < data.length; i += 4) {
    const v = opened[i/4];
    data[i] = data[i+1] = data[i+2] = v;
  }

  // 5. 去除小噪點 (連通域過濾，保留面積 > 20 像素的區域)
  // 簡單實作：使用二次迭代的開運算與閉運算加大核
  let temp = openBinary(openBinary(opened, w, h, 2), w, h, 2);
  temp = closeBinary(closeBinary(temp, w, h, 2), w, h, 2);
  for (let i = 0; i < data.length; i += 4) {
    const v = temp[i/4];
    data[i] = data[i+1] = data[i+2] = v;
  }

  // 6. 自動裁切文字區域 (基於投影)
  const cropped = autoCropByProjection(new Uint8ClampedArray(data.slice(0, w*h)), w, h);
  if (cropped) {
    const outCanvas = document.createElement('canvas');
    outCanvas.width = cropped.w;
    outCanvas.height = cropped.h;
    const outCtx = outCanvas.getContext('2d');
    const outImg = outCtx.createImageData(cropped.w, cropped.h);
    for (let y = 0; y < cropped.h; y++) {
      for (let x = 0; x < cropped.w; x++) {
        const src = cropped.data[y * cropped.w + x];
        const dstIdx = (y * cropped.w + x) * 4;
        outImg.data[dstIdx] = outImg.data[dstIdx+1] = outImg.data[dstIdx+2] = src;
        outImg.data[dstIdx+3] = 255;
      }
    }
    outCtx.putImageData(outImg, 0, 0);
    return outCanvas;
  }

  // 若裁切失敗，返回原始處理後的 canvas
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d');
  const outImg = outCtx.createImageData(w, h);
  for (let i = 0; i < data.length; i++) {
    outImg.data[i] = data[i];
  }
  outCtx.putImageData(outImg, 0, 0);
  return outCanvas;
}

// 二值圖像膨脹 (0 為黑前景, 255 為白背景)
function dilateBinary(bin, w, h, radius) {
  const out = new Uint8ClampedArray(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let min = 255; // 找鄰域內最暗 (最小值) 因為黑色為0
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const idx = ny * w + nx;
          if (bin[idx] < min) min = bin[idx];
        }
      }
      out[y * w + x] = min;
    }
  }
  return out;
}

// 二值圖像侵蝕
function erodeBinary(bin, w, h, radius) {
  const out = new Uint8ClampedArray(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let max = 0; // 找鄰域內最亮 (最大值)
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const idx = ny * w + nx;
          if (bin[idx] > max) max = bin[idx];
        }
      }
      out[y * w + x] = max;
    }
  }
  return out;
}

function openBinary(bin, w, h, radius) {
  return dilateBinary(erodeBinary(bin, w, h, radius), w, h, radius);
}
function closeBinary(bin, w, h, radius) {
  return erodeBinary(dilateBinary(bin, w, h, radius), w, h, radius);
}

// 投影裁切
function autoCropByProjection(bin, w, h) {
  // 水平投影
  const hProj = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x] === 0) sum++; // 黑色計數
    }
    hProj[y] = sum;
  }
  // 垂直投影
  const vProj = new Uint32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < h; y++) {
      if (bin[y * w + x] === 0) sum++;
    }
    vProj[x] = sum;
  }
  // 門檻：最大值的 10%
  const hThresh = Math.max(1, Math.max(...hProj) * 0.1);
  const vThresh = Math.max(1, Math.max(...vProj) * 0.1);
  let top = 0, bottom = h - 1;
  while (top < h && hProj[top] < hThresh) top++;
  while (bottom > top && hProj[bottom] < hThresh) bottom--;
  let left = 0, right = w - 1;
  while (left < w && vProj[left] < vThresh) left++;
  while (right > left && vProj[right] < vThresh) right--;
  if (bottom < top || right < left) return null;
  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  const cropped = new Uint8ClampedArray(cropW * cropH);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const src = bin[(top + y) * w + (left + x)];
      const dst = y * cropW + x;
      cropped[dst] = src;
    }
  }
  return { data: cropped, w: cropW, h: cropH };
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
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && /[A-Za-z0-9\u4e00-\u9fff]/.test(l))
    .join('\n');
}

// ---------- 名片欄位解析 ----------
function parseBusinessCardFields(text) {
  const lines = text.split('\n');
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

  const fullText = lines.join('\n');

  // 姓名：第一行
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
  const taxMatch = fullText.match(/\b\d{8}\b/);
  if (taxMatch) taxId = taxMatch[0];

  // 電話：包含 電話 或 Tel 或 886 + 區號
  const phoneMatch = fullText.match(/(?:電話|Tel|Phone)[：:\\s]*[\\d\\s\\-#]+/);
  if (phoneMatch) phone = phoneMatch[0].replace(/^[^\d]+/, '');
  else {
    const alt = fullText.match(/886\s*\d{2,4}[\s\-]?\d{6,8}/);
    if (alt) phone = alt[0];
  }

  // 傳真：包含 傳真 或 Fax
  const faxMatch = fullText.match(/(?:傳真|Fax)[：:\\s]*[\\d\\s\\-]+/);
  if (faxMatch) fax = faxMatch[0].replace(/^[^\d]+/, '');

  // 手機：包含 手機 或 Mobile 或 886 9xxxxxxx
  const mobileMatch = fullText.match(/(?:手機|Mobile|Cell)[：:\\s]*[\\d\\s\\-]+/);
  if (mobileMatch) mobile = mobileMatch[0].replace(/^[^\d]+/, '');
  else {
    const alt = fullText.match(/886\s*9\d{8}/);
    if (alt) mobile = alt[0];
  }

  // Email
  const emailMatch = fullText.match(/[\w\.-]+@[\w\.-]+\.[\w]{2,}/);
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
  return lines.join('\r\n');
}