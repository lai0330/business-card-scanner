const video = document.getElementById('preview');
const captureBtn = document.getElementById('captureBtn');
const resultDiv = document.getElementById('result');
const downloadLink = document.getElementById('downloadLink');

console.log('Script loaded');

// 1️⃣ 取得後鏡頭
navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
  .then(stream => { video.srcObject = stream; })
  .catch(err => { alert('無法取得相機：' + err); });

// 2️⃣ 拍照並送到 OCR (含圖像預處理)
captureBtn.addEventListener('click', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // 預處理：放大 2x、灰階、對比增強、二值化
  const scale = 2;
  const scaledCanvas = document.createElement('canvas');
  scaledCanvas.width = canvas.width * scale;
  scaledCanvas.height = canvas.height * scale;
  const sctx = scaledCanvas.getContext('2d');
  sctx.drawImage(canvas, 0, 0, scaledCanvas.width, scaledCanvas.height);

  const imgData = sctx.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // 灰階
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    // 對比增強
    let contrast = (gray - 128) * 1.8 + 128;
    if (contrast < 0) contrast = 0;
    if (contrast > 255) contrast = 255;
    // 二值化（閾值 180）
    const binary = contrast > 180 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = binary;
    // data[i+3] unchanged
  }
  sctx.putImageData(imgData, 0, 0);

  const processedImgData = scaledCanvas.toDataURL('image/jpeg');

  resultDiv.textContent = 'OCR 辨識中…';
  try {
    const { data: { text } } = await Tesseract.recognize(
      processedImgData,
      'chi_tra+eng',
      {
        logger: m => console.log(m),
        // psm 6 假設單一均勻文字塊
        // 可調整
      }
    );
    // 3️⃣ 簡單欄位擷取（僅示例，可依名片格式調整）
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const name = lines[0] || '';
    const phone = lines.find(l => /(\d{4}[-\s]?\d{3}[-\s]?\d{3})/.test(l)) || '';
    const email = lines.find(l => /[\w\.-]+@[\w\.-]+\.\w+/.test(l)) || '';
    const org = lines.find(l => l.length > 2 && !/^\d/.test(l) && l !== name && l !== phone && l !== email) || '';

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

    const blob = new Blob([vcard], {type: 'text/vcard'});
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = 'contact.vcard';
    downloadLink.style.display = 'inline-block';
    downloadLink.textContent = '下載 vCard（點擊後在 iOS 上選「開啟 → 通訊錄」）';

    resultDiv.innerHTML = `<strong>辨識結果：</strong><pre>${text}</pre>`;
  } catch (e) {
    resultDiv.textContent = 'OCR 失敗：' + e;
  }
});
