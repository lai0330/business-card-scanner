// version number is in HTML

// 1️⃣ 取得後鏡頭
const video = document.getElementById('preview');
const captureBtn = document.getElementById('captureBtn');
const resultDiv = document.getElementById('result');
const downloadLink = document.getElementById('downloadLink');

navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
  .then(stream => { video.srcObject = stream; })
  .catch(err => { alert('無法取得相機：' + err); });

// 2️⃣ 拍照 + 前處理 + 分區 OCR
captureBtn.addEventListener('click', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // 前處理：灰階 → 3x3 均值模糊 → 自適應二值化
  const { binaryImg, width, height } = preprocessToBinary(canvas);

  // 找出最大連通區域（假設為名片）
  const { x: cardX, y: cardY, w: cardW, h: cardH } = findLargestComponent(binaryImg, width, height);

  // Guard against zero-sized component (no foreground detected)
  let useCanvas = canvas;
  let useX = 0, useY = 0, useW = width, useH = height;
  if (cardW > 0 && cardH > 0) {
    // 裁切名片區域
    const cardCanvas = document.createElement('canvas');
    cardCanvas.width = cardW;
    cardCanvas.height = cardH;
    const cardCtx = cardCanvas.getContext('2d');
    cardCtx.drawImage(
      canvas,
      cardX, cardY, cardW, cardH,
      0, 0, cardW, cardH
    );
    useCanvas = cardCanvas;
    useX = 0; useY = 0; useW = cardW; useH = cardH;
  }

  // 進一步二值化裁切區域（用於行分割）
  const { binaryImg: cardBinary, width: cW, height: cH } = preprocessToBinary(useCanvas);

  // 水平投影尋找行間距
  const lineBoxes = splitIntoLines(cardBinary, cW, cH);

  // 對每行進行 OCR
  let fullText = '';
  for (const { x0, y0, w, h } of lineBoxes) {
    // 裁切行圖
    const lineCanvas = document.createElement('canvas');
    lineCanvas.width = w;
    lineCanvas.height = h;
    const lineCtx = lineCanvas.getContext('2d');
    lineCtx.drawImage(
      useCanvas,
      x0, y0, w, h,
      0, 0, w, h
    );
    // 再次前處理以提升 OCR
    const { binaryImg: lineBinary, width: lw, height: lh } = preprocessToBinary(lineCanvas);
    // 產生白底黑字的可顯示圖像（供 Tesseract 識別）
    const lineDisplay = binaryToDisplayImage(lineBinary, lw, lh);
    const imgData = lineDisplay.toDataURL('image/jpeg');

    try {
      const { data: { text } } = await Tesseract.recognize(
        imgData,
        'chi_tra+eng',
        { logger: m => console.log(m), tessedit_pageseg_mode: 7 } // 單行文字
      );
      if (text.trim()) {
        fullText += text.trim() + '\n';
      }
    } catch (e) {
      console.error('OCR line error:', e);
    }
  }

  // 若沒偵測到任何行，退回整張圖 OCR
  if (!fullText.trim()) {
    const imgData = useCanvas.toDataURL('image/jpeg');
    try {
      const { data: { text } } = await Tesseract.recognize(
        imgData,
        'chi_tra+eng',
        { logger: m => console.log(m) }
      );
      fullText = text;
    } catch (e) {
      resultDiv.textContent = 'OCR 失敗：' + e;
      return;
    }
  }

  // 後處理清理（基本）
  const cleaned = fullText
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
    .trim();

  resultDiv.innerHTML = `<strong>辨識結果：</strong><pre>${cleaned}</pre>`;

  // 產生 vCard（簡易欄位擷取，僅示例）
  const lines = cleaned.split('\n').filter(l => l);
  const name = lines[0] || '';
  const phone = lines.find(l => /(\d{4}[-\s]?\d{3}[-\s]?\d{3})/.test(l)) || '';
  const email = lines.find(l => /[\w\.-]+@[\w\.-]+\.\w+/.test(l)) || '';
  const org = lines.find(l => l.length > 2 && !/^\d/.test(l) && l !== name && l !== phone && l !== email) || '';

  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `ORG:${org}`,
    `TEL;TYPE=WORK,VOICE:${phone.replace(/[^0-9+]/g, '')}`,
    `EMAIL:${email}`,
    'END:VCARD'
  ].join('\r\n');

  const blob = new Blob([vcard], {type: 'text/vcard'});
  const url = URL.createObjectURL(blob);
  downloadLink.href = url;
  downloadLink.download = 'contact.vcard';
  downloadLink.style.display = 'inline-block';
  downloadLink.textContent = '下載 vCard（點擊後在 iOS 上選「開啟 → 通訊錄」）';
});

// ---------- 前處理：灰階 → 3x3 均值模糊 → 自適應二值化（局部均值減偏移） ----------
function preprocessToBinary(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8ClampedArray(w * h);
  // 轉灰階
  for (let i = 0, j = 0; i < imgData.length; i += 4, j++) {
    const r = imgData[i], g = imgData[i+1], b = imgData[i+2];
    gray[j] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  // 3x3 均值模糊
  const blurred = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += gray[ny * w + nx];
          count++;
        }
      }
      blurred[y * w + x] = Math.round(sum / count);
    }
  }
  // 自適應二值化：局部均值 - offset
  const binary = new Uint8ClampedArray(w * h);
  const offset = 10;
  // 計算每個像素的局部均值（使用 3x3 窗口）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += blurred[ny * w + nx];
          count++;
        }
      }
      const mean = Math.round(sum / count);
      const idx = y * w + x;
      binary[idx] = blurred[idx] > mean - offset ? 255 : 0; // 255 為白底（背景），0 為黑字
    }
  }
  return { binaryImg: binary, width: w, height: h };
}

// ---------- 尋找最大連通區域（基於前景黑色 pixel 值 0） ----------
function findLargestComponent(bin, w, h) {
  const visited = new Uint8ClampedArray(w * h);
  let best = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (visited[y * w + x] !== 0) continue;
      if (bin[y * w + x] !== 0) { // 背景白色，跳過
        visited[y * w + x] = 255;
        continue;
      }
      // 發現前景黑色點，進行 BFS
      const queue = [[x, y]];
      visited[y * w + x] = 255;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      while (queue.length) {
        const [cx, cy] = queue.pop();
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        // 4鄰域
        const neighbours = [
          [cx - 1, cy], [cx + 1, cy],
          [cx, cy - 1], [cx, cy + 1]
        ];
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const idx = ny * w + nx;
          if (visited[idx] !== 0) continue;
          if (bin[idx] === 0) {
            visited[idx] = 255;
            queue.push([nx, ny]);
          } else {
            visited[idx] = 255; // 標記為已訪問（背景也標記以免重複檢查）
          }
        }
      }
      if (area > best.area) {
        best = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area };
      }
    }
  }
  return best; // 若未找到前景，則返回零區域
}

// ---------- 水平投影切割成行 ----------
function splitIntoLines(bin, w, h) {
  const lineSums = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x] === 0) sum++; // 前景黑色計數
    }
    lineSums[y] = sum;
  }
  // 計算動態閾值：最大值的 10%（若全為0則設為1）
  const max = Math.max(...lineSums);
  const threshold = Math.max(1, Math.floor(max * 0.1));
  const lines = [];
  let i = 0;
  while (i < h) {
    // 跳過空白行
    while (i < h && lineSums[i] < threshold) i++;
    if (i >= h) break;
    const start = i;
    while (i < h && lineSums[i] >= threshold) i++;
    const end = i - 1;
    const lineH = end - start + 1;
    // 找此行的左右邊界（非零區域）
    let minX = w, maxX = 0;
    for (let y = start; y <= end; y++) {
      for (let x = 0; x < w; x++) {
        if (bin[y * w + x] === 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    if (maxX >= minX) {
      lines.push({ x0: minX, y0: start, w: maxX - minX + 1, h: lineH });
    }
  }
  return lines;
}

// ---------- 二值圖轉為可顯示的 Canvas（白底黑字） ----------
function binaryToDisplayImage(bin, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let i = 0; i < bin.length; i++) {
    const v = bin[i];
    const idx = i * 4;
    data[idx] = data[idx + 1] = data[idx + 2] = v; // 0 黑, 255 白
    data[idx + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}