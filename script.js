// version display
const versionEl = document.getElementById('version');
versionEl.textContent = 'v2.3 (ROI指引框+灰階+對比拉伸+Otsu二值化+Tesseract OCR)';

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
  const canvas = documentWidth height from video');
  // We'll compute ROI based on video dimensions and the fixed guide (20% margin, 60% size)
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const margin = 0.2; // 20% from each side
  const roiX = Math.round(vw * margin);
  const roiY = Math.round(vh * margin);
  const roiW = Math.round(vw * (1 - 2*margin));
  const roiH = Math.round(vh * (1 - 2*margin));

  const canvas = document.createElement('canvas');
  canvas.width = roiW;
  canvas.height = roiH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, roiW, roiH);

  // 前處理：灰階 → 對比拉伸 → Otsu 二值化
  const processed = preprocessImage(canvas);
  const imgDataUrl = processed.toDataURL('image/jpeg');

  resultDiv.textContent = 'OCR 辨識中…';
  try {
    const { data: { text } } = await Tesseract.recognize(
      imgDataUrl,
      'chi_tra+eng',
      { logger: m => console.log(m) }
    );

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

// ---------- 前處理函式 ----------
function preprocessImage(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d');
  let imgData = ctx.getImageData(0, 0, w, h);
  let data = new Uint8ClampedArray(imgData.data); // copy

  // 1. 轉灰階 (使用 NTSC 加權)
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const r = data[i], g = data[i+1], b = data[i+2];
    gray[j] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // 2. 對比拉伸 (最小-最大)
  let min = 255, max = 0;
  for (let v of gray) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range > 0) {
    for (let i = 0; i < gray.length; i++) {
      let v = gray[i];
      v = ((v - min) * 255) / range;
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      gray[i] = v;
    }
  }

  // 3. Otsu 二值化
  // 計算直方圖
  const hist = new Array(256).fill(0);
  let total = 0;
  for (let v of gray) {
    hist[v]++;
    total++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVar = 0;
  let threshold = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * Math.pow(mB - mF, 2);
    if (between > maxVar) {
      maxVar = between;
      threshold = i;
    }
  }
  // 二值化：0 黑 (前景), 255 白 (背景)
  const binary = new Uint8ClampedArray(w * h);
  for (let i = 0; i < gray.length; i++) {
    binary[i] = gray[i] > threshold ? 255 : 0;
  }

  // 4. 形態學開運算 (去噪) – 使用 3x3 核
  // 先侵蝕後膨脹 = 開
  let eroded = erodeBinary(binary, w, h, 1);
  let opened = dilateBinary(eroded, w, h, 1);

  // 5. 自動裁切文字區域 (基於投影)
  const cropped = autoCropByProjection(opened, w, h);
  const finalBinary = cropped ? cropped.data : opened;
  const finalW = cropped ? cropped.w : w;
  const finalH = cropped ? cropped.h : h;

  // 建立結果 canvas (白底黑字)
  const outCanvas = document.createElement('canvas');
  outCanvas.width = finalW;
  outCanvas.height = finalH;
  const outCtx = outCanvas.getContext('2d');
  const outImg = outCtx.createImageData(finalW, finalH);
  const outData = outImg.data;
  for (let i = 0; i < finalBinary.length; i++) {
    const v = finalBinary[i];
    const idx = i * 4;
    outData[idx] = outData[idx+1] = outData[idx+2] = v;
    outData[idx+3] = 255;
  }
  outCtx.putImageData(outImg, 0, 0);
  return outCanvas;
}

function erodeBinary(bin, w, h, radius) {
  const out = new Uint8ClampedArray(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let min = 255;
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
      const idx = y * w + x;
      out[idx] = min;
    }
  }
  return out;
}

function dilateBinary(bin, w, h, radius) {
  const out = new Uint8ClampedArray(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let max = 0;
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
      const idx = y * w + x;
      out[idx] = max;
    }
  }
  return out;
}

function autoCropByProjection(bin, w, h) {
  // 水平投影 (黑色像素計數)
  const hProj = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x] === 0) sum++;
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