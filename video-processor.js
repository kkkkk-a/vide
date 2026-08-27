/**
 * VideoProcessor - 映像・音声処理エンジン
 * クリップ速度変更、逆再生、無音自動検出カット
 */
class VideoProcessor {
  // ★ 拡張可能な 2D 図形パステーブル
  static SHAPE_PATHS = {
    'rect': (ctx, w, h) => ctx.rect(-w / 2, -h / 2, w, h),
    'circle': (ctx, w, h) => ctx.arc(0, 0, w / 2, 0, Math.PI * 2),
    'rounded-rect': (ctx, w, h) => {
      const r = Math.min(24, Math.min(w, h) * 0.2);
      typeof ctx.roundRect === 'function' ? ctx.roundRect(-w / 2, -h / 2, w, h, r) : ctx.rect(-w / 2, -h / 2, w, h);
    },
    'triangle': (ctx, w, h) => {
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
    },
    'star': (ctx, w, h) => {
      const pts = 5;
      const hw = w / 2;
      for (let i = 0; i < pts * 2; i++) {
        const l = i % 2 === 1 ? hw * 0.45 : hw;
        const a = (i / (pts * 2)) * Math.PI * 2 - Math.PI / 2;
        const px = Math.cos(a) * l;
        const py = Math.sin(a) * l;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    },
    'heart': (ctx, w, h) => {
      const s = (w / 2) * 0.016;
      ctx.moveTo(0, s * -15);
      ctx.bezierCurveTo(s * 25, s * -45, s * 60, s * -5, 0, s * 45);
      ctx.bezierCurveTo(s * -60, s * -5, s * -25, s * -45, 0, s * -15);
      ctx.closePath();
    },
    'diamond': (ctx, w, h) => {
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(0, h / 2);
      ctx.lineTo(-w / 2, 0);
      ctx.closePath();
    },
    'hexagon': (ctx, w, h) => {
      const hw = w / 2;
      const hh = h / 2;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
        const px = Math.cos(a) * hw;
        const py = Math.sin(a) * hh;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    },
    'arrow': (ctx, w, h) => {
      const hw = w / 2;
      const hh = h / 2;
      ctx.moveTo(-hw, -hh * 0.35);
      ctx.lineTo(0, -hh * 0.35);
      ctx.lineTo(0, -hh);
      ctx.lineTo(hw, 0);
      ctx.lineTo(0, hh);
      ctx.lineTo(0, hh * 0.35);
      ctx.lineTo(-hw, hh * 0.35);
      ctx.closePath();
    },
    'speech-bubble': (ctx, w, h) => {
      const r = 16, bw = w, bh = h * 0.75, top = -h / 2, left = -w / 2;
      ctx.moveTo(left + r, top);
      ctx.lineTo(left + bw - r, top);
      ctx.quadraticCurveTo(left + bw, top, left + bw, top + r);
      ctx.lineTo(left + bw, top + bh - r);
      ctx.quadraticCurveTo(left + bw, top + bh, left + bw - r, top + bh);
      ctx.lineTo(left + bw * 0.35, top + bh);
      ctx.lineTo(left + bw * 0.20, h / 2);
      ctx.lineTo(left + bw * 0.20, top + bh);
      ctx.lineTo(left + r, top + bh);
      ctx.quadraticCurveTo(left, top + bh, left, top + bh - r);
      ctx.lineTo(left, top + r);
      ctx.quadraticCurveTo(left, top, left + r, top);
      ctx.closePath();
    }
  };

  constructor() {}

  /**
   * クリップの再生速度を変更
   * @param {Object} clip - 対象クリップ
   * @param {number} speed - 速度倍率 (0.25 〜 4.0)
   */
  setClipSpeed(clip, speed = 1.0) {
    const safeSpeed = Math.max(0.25, Math.min(4.0, speed));
    const oldSpeed = clip.playbackSpeed || 1.0;
    clip.playbackSpeed = safeSpeed;

    if (clip.element) {
      clip.element.playbackRate = safeSpeed;
      clip.element.preservesPitch = false;
    }

    // 基準尺（originalDuration）が未定義の場合は現在の速度から逆算して固定
    if (clip.originalDuration === undefined) {
      clip.originalDuration = clip.duration * oldSpeed;
    }
    clip.duration = Math.max(0.1, clip.originalDuration / safeSpeed);
  }

  /**
   * 音声波形から無音区間を自動検出してカット対象区間（発話区間）の配列を返却
   * @param {AudioBuffer} audioBuffer - 解析する音声バッファ
   * @param {number} threshold - 無音判定の閾値 (0.01 〜 0.1)
   * @param {number} minSilenceDuration - 無音と判定する最小秒数 (例: 0.4秒)
   * @returns {Array<{start: number, end: number}>} 発話区間リスト
   */
  detectSpeechSegments(audioBuffer, threshold = 0.025, minSilenceDuration = 0.4) {
    const rawData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.floor(sampleRate * 0.05); // 50ms 単位で振幅解析
    const minSilenceSamples = Math.floor(sampleRate * minSilenceDuration);

    const segments = [];
    let isSpeaking = false;
    let speechStart = 0;
    let silenceSamples = 0;

    for (let i = 0; i < rawData.length; i += windowSize) {
      let sum = 0;
      const end = Math.min(i + windowSize, rawData.length);
      for (let j = i; j < end; j++) {
        sum += Math.abs(rawData[j]);
      }
      const rms = sum / (end - i);
      const currentTime = i / sampleRate;

      if (rms >= threshold) {
        if (!isSpeaking) {
          isSpeaking = true;
          speechStart = Math.max(0, currentTime - 0.05); // アタックスキップ防止マージン
        }
        silenceSamples = 0;
      } else {
        if (isSpeaking) {
          silenceSamples += windowSize;
          if (silenceSamples >= minSilenceSamples) {
            isSpeaking = false;
            const speechEnd = currentTime;
            const minSpeechDuration = 0.2; // 最小発話区間（200ms以上を有効判定）
            if (speechEnd - speechStart >= minSpeechDuration) {
              segments.push({ start: speechStart, end: speechEnd });
            }
          }
        }
      }
    }

    const totalDuration = rawData.length / sampleRate;
    if (isSpeaking) {
      const speechEnd = totalDuration;
      const minSpeechDuration = 0.2;
      if (speechEnd - speechStart >= minSpeechDuration) {
        segments.push({ start: speechStart, end: speechEnd });
      }
    }

    return segments;
  }

  /**
   * AudioBuffer を時間軸反転させた新しい AudioBuffer を生成（音声逆再生）
   * @param {AudioContext} audioCtx
   * @param {AudioBuffer} sourceBuffer
   * @returns {AudioBuffer}
   */
  // ★ 高速化された音声バッファ反転（逆再生）
  reverseAudioBuffer(audioCtx, sourceBuffer) {
    const numChannels = sourceBuffer.numberOfChannels;
    const length = sourceBuffer.length;
    const sampleRate = sourceBuffer.sampleRate;
    const reversedBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);

    for (let c = 0; c < numChannels; c++) {
      const srcData = sourceBuffer.getChannelData(c);
      const dstData = reversedBuffer.getChannelData(c);
      // TypedArray のバッチコピー後に反転
      dstData.set(srcData);
      dstData.reverse();
    }

    return reversedBuffer;
  }

  /**
   * 音声データのキック・リズム（低音エネルギーの急峻変化）を解析してビート位置（秒数）を抽出
   * @param {AudioBuffer} audioBuffer
   * @param {number} sensitivity - 感度 (1.0: 厳しい 〜 1.8: 敏感)
   * @param {number} minIntervalSec - ビート同士の最小間隔（過剰打刻防止・デフォルト0.2秒）
   * @returns {Float32Array} 検出されたビート秒数配列
   */
  detectBeats(audioBuffer, sensitivity = 1.35, minIntervalSec = 0.2) {
    const rawData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = rawData.length;

    // 20msごとの短時間エネルギーブロックに分割（軽量・高速解析）
    const blockSize = Math.floor(sampleRate * 0.02);
    const numBlocks = Math.floor(totalSamples / blockSize);
    const blockEnergies = new Float32Array(numBlocks);

    // 1. 各ブロックの局所低周波エネルギーを計算
    for (let b = 0; b < numBlocks; b++) {
      const start = b * blockSize;
      const end = start + blockSize;
      let sum = 0;
      for (let i = start; i < end; i++) {
        const val = rawData[i];
        sum += val * val;
      }
      blockEnergies[b] = sum / blockSize;
    }

    // 2. 移動平均（局所環境音量）に対する急激なエネルギー立ち上がり（Onset）を検出
    const historyBlocks = Math.floor(0.4 / 0.02); // 過去400msの平均と比較
    const beatTimes = [];
    let lastBeatTime = -minIntervalSec;

    for (let b = historyBlocks; b < numBlocks; b++) {
      let localSum = 0;
      for (let h = b - historyBlocks; h < b; h++) {
        localSum += blockEnergies[h];
      }
      const localAvg = localSum / historyBlocks;
      const currentEnergy = blockEnergies[b];
      const time = (b * blockSize) / sampleRate;

      // 局所平均の閾値倍以上 かつ 一定以上の絶対音量 かつ 最小間隔を満たす場合
      if (currentEnergy > localAvg * sensitivity && currentEnergy > 0.005 && (time - lastBeatTime) >= minIntervalSec) {
        beatTimes.push(parseFloat(time.toFixed(3)));
        lastBeatTime = time;
      }
    }

    return beatTimes;
  }

  /**
   * Adobe / DaVinci 標準 .cube 3D-LUT テキストを解析して 3次元テーブル配列を返却
   * @param {string} cubeText
   * @returns {{ size: number, table: Float32Array }}
   */
  parseCubeLUT(cubeText) {
    const lines = cubeText.split('\n');
    let size = 0;
    const table = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('LUT_3D_SIZE')) {
        size = parseInt(line.split(/\s+/)[1], 10);
      } else {
        const parts = line.split(/\s+/).map(Number);
        if (parts.length === 3 && !isNaN(parts[0])) {
          table.push(parts[0], parts[1], parts[2]);
        }
      }
    }

    if (size > 0 && table.length === size * size * size * 3) {
      return {
        size: size,
        table: new Float32Array(table)
      };
    } else {
      throw new Error("無効な 3D-LUT 構造です");
    }
  }

  /**
   * メディア要素から音声をデコードして発話区間リストを直接抽出
   * @param {HTMLMediaElement} element
   * @param {AudioContext} audioCtx
   * @param {number} threshold
   * @returns {Promise<Array<{start: number, end: number}>>}
   */
  async extractSpeechSegmentsFromElement(element, audioCtx, threshold = 0.025) {
    if (!element?.src) throw new Error("対象メディアのURLが存在しません");
    const response = await fetch(element.src);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return this.detectSpeechSegments(audioBuffer, threshold, 0.4);
  }
}

window.VideoProcessor = new VideoProcessor();