const video = document.getElementById('preview');
const captureBtn = document.getElementById('captureBtn');
const resultDiv = document.getElementById('result');
const downloadLink = document.getElementById('downloadLink');

// 版本資訊
const versionInfo = document.createElement('div');
versionInfo.style.fontSize = '0.8em';
versionInfo.style.color = '#666';
versionInfo.style.marginTop = '1em';
versionInfo.textContent = '版本: v1.3 (強化中文名片 OCR：自動裁切、二值化、去噪、PSM 4/6 自適應)';
document.body.appendChild(versionInfo);

// 1️⃣ 取得後鏡頭
navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
  .then(stream => { video.srcObject = stream; })
  .catch(err => { alert('無法取得相機：' + err); });

// --- 影像前處理工具函式 ---
function toGrayscale(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    data[i] = data[i+1] = data[i+2] = gray;
  }
  ctx.putImageData(imgData, 0, 0);
}

function enhanceContrast(ctx, w, h, factor = 1.8) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i]; // 灰階後 R=G=B
    let c = (v - 128) * factor + 128;
    if (c < 0) c = 0;
    if (c > 255) c = 255;
    data[i] = data[i+1] = data[i+2] = c;
  }
  ctx.putImageData(imgData, 0, 0);
}

function binarize(ctx, w, h, threshold = 140) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    const bw = v > threshold ? 255 : 0;
    data[i] = data[i+1] = data[i+2] = bw;
  }
  ctx.putImageData(imgData, 0, 0);
}

function denoise(ctx, w, h) {
  // 簡單 3x3 中值濾波（只處理黑白二值圖）
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  for (let y = 1; y < h-1; y++) {
    for (let x = 1; x < w-1; x++) {
      const idx = (y*w + x)*4;
      const vals = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nidx = ((y+dy)*w + (x+dx))*4;
          vals.push(data[nidx]);
        }
      }
      vals.sort((a,b)=>a-b);
      out[idx] = out[idx+1] = out[idx+2] = vals[4]; // 中位數
      out[idx+3] = 255;
    }
  }
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
}

function autoCropCard(ctx, w, h) {
  // 找出非白邊界，回傳裁切後的新 canvas
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y*w + x)*4;
      if (data[idx] < 200) { // 非白
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return null;
  // 加一些 padding
  const pad = 20;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w-1, maxX + pad);
  maxY = Math.min(h-1, maxY + pad);
  const cropW = maxX - minX;
  const cropH = maxY - minY;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  cropCanvas.getContext('2d').drawImage(ctx.canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  return cropCanvas;
}

// 2️⃣ 拍照並送 OCR
captureBtn.addEventListener('click', async () => {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = video.videoWidth;
  srcCanvas.height = video.videoHeight;
  const ctx = srcCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, srcCanvas.width, srcCanvas.height);

  // 前處理流程
  toGrayscale(ctx, srcCanvas.width, srcCanvas.height);
  enhanceContrast(ctx, srcCanvas.width, srcCanvas.height, 1.8);
  binarize(ctx, srcCanvas.width, srcCanvas.height, 140);
  denoise(ctx, srcCanvas.width, srcCanvas.height);

  // 自動裁切名片區域
  const cardCanvas = autoCropCard(ctx, srcCanvas.width, srcCanvas.height);
  const finalCanvas = cardCanvas || srcCanvas;

  const imgDataUrl = finalCanvas.toDataURL('image/jpeg', 0.95);

  resultDiv.textContent = 'OCR 辨識中…';
  try {
    // 先試 PSM 4（單欄文字），再試 PSM 6（單一均勻區塊），取較長結果
    const recog = async (psm) => {
      const { data: { text } } = await Tesseract.recognize(
        imgDataUrl,
        'chi_tra+eng',
        { logger: m => console.log(m), tessedit_pageseg_mode: psm }
      );
      return text;
    };

    const [text4, text6] = await Promise.all([recog(4), recog(6)]);
    const text = text4.length >= text6.length ? text4 : text6;

    // --- 後處理：簡單清理常見誤識 ---
    const clean = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      // 移除只含符號的行
      .filter(l => /[A-Za-z0-9\u4e00-\u9fff]/.test(l))
      .join('\n');

    // 3️⃣ 欄位擷取（可再依實際名片格式微調）
    const lines = clean.split('\n');
    const name = lines[0] || '';
    const phone = lines.find(l => /(\d{2,4}[-\s]?\d{3,4}[-\s]?\d{3,4})/.test(l)) || '';
    const email = lines.find(l => /[\w\.-]+@[\w\.-]+\.\w+/.test(l)) || '';
    // 公司/職稱：非姓名、非電話、非 email 的第一行
    const org = lines.find(l => l !== name && l !== phone && l !== email && l.length > 1) || '';

    // 4️⃣ 產生 vCard
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${name}`,
      `ORG:${org}`,
      `TEL;TYPE=WORK,VOICE:${phone.replace(/[^0-9+]/g, '')}`,
      `EMAIL:${email}`,
      'END:VCARD'
    ].join('\r\n');

    const blob = new Blob([vcard], { type: 'text/vcard' });
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = 'contact.vcard';
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '下載 vCard（點擊後在 iOS 上選「開啟 → 通訊錄」）';

    resultDiv.innerHTML = `<strong>辨識結果：</strong><pre>${clean}</pre>`;
  } catch (e) {
    resultDiv.textContent = 'OCR 失敗：' + e;
  }
});
