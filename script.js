// version display
const versionEl = document.getElementById('version');
if (versionEl) {
    versionEl.textContent = 'v4.0';
}

// 1️⃣ 取得後鏡頭
const video = document.getElementById('preview');
const captureBtn = document.getElementById('captureBtn');
const resultDiv = document.getElementById('result');
const downloadLink = document.getElementById('downloadLink');
const debugImg = document.getElementById('debugImg');

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

  // 前處理：灰階 + 對比拉伸 (簡單)
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  // 轉灰階 (平均)
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
    data[i] = data[i+1] = data[i+2] = gray;
  }
  // 對比拉伸：找 min/max
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
  ctx.putImageData(imgData, 0, 0);

  const imgDataUrl = canvas.toDataURL('image/jpeg');

  // 顯示預處理後圖片（除錯用）
  if (debugImg) {
    debugImg.innerHTML = '';
    const img = document.createElement('img');
    img.src = imgDataUrl;
    img.style.maxWidth = '100%';
    debugImg.appendChild(img);
  }

  resultDiv.textContent = 'OCR 辨識中…';
  try {
    const { data: { text } } = await Tesseract.recognize(
      imgDataUrl,
      'chi_tra+eng',
      { logger: m => console.log(m) }
    );

    // 簡單欄位擷取
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const name = lines[0] || '';
    const phone = lines.find(l => /(\d{4}[-\s]?\d{3}[-\s]?\d{3})/.test(l)) || '';
    const email = lines.find(l => /[\w\.-]+@[\w\.-]+\.\w+/.test(l)) || '';
    const org = lines.find(l => l.length > 2 && !/^\d/.test(l) && l !== name && l !== phone && l !== email) || '';

    // 產生 vCard
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