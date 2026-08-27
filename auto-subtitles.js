/**
 * AutoSubtitlesEngine - Whisper AI による全自動字幕起こし
 */
class AutoSubtitlesEngine {
  static async transcribeAudioClip(clip, audioCtx, onProgress) {
    if (!clip || !clip.element) throw new Error("対象のメディア素材がありません。");

    onProgress("音声データを準備中...");
    const response = await fetch(clip.element.src);
    let arrayBuffer = await response.arrayBuffer();
    const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    arrayBuffer = null; // デコード完了後、巨大な生バッファを即座に解放

    // ★ Whisper AI が要求する 16,000Hz (16kHz) モノラルにリサンプリング
    const targetSampleRate = 16000;
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      1,
      Math.ceil(decodedBuffer.duration * targetSampleRate),
      targetSampleRate
    );
    const sourceNode = offlineCtx.createBufferSource();
    sourceNode.buffer = decodedBuffer;
    sourceNode.connect(offlineCtx.destination);
    sourceNode.start(0);
    const resampledBuffer = await offlineCtx.startRendering();
    const audioData = resampledBuffer.getChannelData(0);

    onProgress("AIモデルを準備中...");
    let waitCount = 0;
    const maxWait = 40; // 最大 8秒待機
    while (!window.transformers && waitCount < maxWait) {
      await new Promise(r => setTimeout(r, 200));
      waitCount++;
    }
    if (!window.transformers) {
      throw new Error("AI字幕ライブラリ (Transformers.js) を読み込めませんでした。ネットワーク接続を確認してください。");
    }

    const { pipeline, env } = window.transformers;
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      progress_callback: (p) => {
        if (p.status === 'downloading') {
          const pct = Math.round((p.loaded / p.total) * 100) || 0;
          onProgress(`AIモデルダウンロード中: ${pct}%`);
        }
      }
    });

    onProgress("音声を解析中...");
    const output = await transcriber(audioData, {
      language: 'japanese',
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5
    });

    if (!output?.chunks || output.chunks.length === 0) {
      throw new Error("発話区間を検出できませんでした。");
    }

    return output.chunks
      .map(c => ({ text: c.text.trim(), start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (c.timestamp[0] + 3.0) }))
      .filter(c => c.text.length > 0);
  }

  // 1本のキーフレーム統合クリップを生成
  static buildMergedCaptionClip(validChunks, baseOffset = 0, totalDuration = 10) {
    const keyframes = validChunks.map(c => ({
      time: parseFloat(c.start.toFixed(2)),
      text: c.text
    }));
    const firstStart = parseFloat((baseOffset + validChunks[0].start).toFixed(2));

    return {
      id: `text-auto-merged-${Date.now()}`,
      type: 'text',
      text: keyframes[0].text,
      textKeyframes: keyframes,
      color: '#ffff00',
      fontFamily: 'M PLUS Rounded 1c',
      fontSize: 48,
      startTime: firstStart,
      duration: parseFloat(totalDuration.toFixed(2)),
      trackIndex: 0,
      transform: { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: -395 }
    };
  }

  // 個別の文字クリップ配列を生成
  static buildSegmentedCaptionClips(validChunks, baseOffset = 0, getAvailableTrackIndex) {
    return validChunks.map((chunk, index) => {
      const clipStart = parseFloat((baseOffset + chunk.start).toFixed(2));
      const clipDur = parseFloat(Math.max(0.1, chunk.end - chunk.start).toFixed(2));
      const trackIdx = getAvailableTrackIndex ? getAvailableTrackIndex(clipStart, clipDur) : 0;

      return {
        id: `text-auto-${Date.now()}-${index}`,
        type: 'text',
        text: this.formatSmartWrap(chunk.text, 18),
        color: '#ffffff',
        fontFamily: 'M PLUS Rounded 1c',
        fontSize: 48,
        startTime: clipStart,
        duration: clipDur,
        trackIndex: trackIdx,
        strokeEnabled: true,
        strokeColor: '#000000',
        strokeWidth: 6,
        stroke2Enabled: true,
        stroke2Color: '#ff2d55',
        stroke2Width: 14,
        transform: { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 }
      };
    });
  }

  // ★ 長文テロップのスマート自動改行 (指定文字数で折り返し)
  static formatSmartWrap(text, maxCharsPerLine = 18) {
    if (!text || text.length <= maxCharsPerLine) return text;
    const regex = new RegExp(`(.{1,${maxCharsPerLine}})(?:[、。！？\\s]|$)`, 'g');
    const lines = text.match(regex) || [text];
    return lines.map(l => l.trim()).filter(Boolean).join('\n');
  }

// ★ YouTube標準 SRT 字幕形式テキストのエクスポート（厳密パディング版）
  static exportToSRT(chunks) {
    const formatTime = (sec) => {
      const safeSec = Math.max(0, isFinite(sec) ? sec : 0);
      const h = String((safeSec / 3600) | 0).padStart(2, '0');
      const m = String(((safeSec % 3600) / 60) | 0).padStart(2, '0');
      const s = String((safeSec % 60) | 0).padStart(2, '0');
      const ms = String(Math.round((safeSec % 1) * 1000)).padStart(3, '0').slice(0, 3);
      return `${h}:${m}:${s},${ms}`;
    };

    return chunks.map((c, idx) => {
      return `${idx + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}\n`;
    }).join('\n');
  }

  // ★ WebVTT 字幕形式テキストのエクスポート（厳密パディング版）
  static exportToVTT(chunks) {
    const formatTime = (sec) => {
      const safeSec = Math.max(0, isFinite(sec) ? sec : 0);
      const h = String((safeSec / 3600) | 0).padStart(2, '0');
      const m = String(((safeSec % 3600) / 60) | 0).padStart(2, '0');
      const s = String((safeSec % 60) | 0).padStart(2, '0');
      const ms = String(Math.round((safeSec % 1) * 1000)).padStart(3, '0').slice(0, 3);
      return `${h}:${m}:${s}.${ms}`;
    };

    const body = chunks.map(c => `${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}`).join('\n\n');
    return `WEBVTT\n\n${body}`;
  }
}

window.AutoSubtitlesEngine = AutoSubtitlesEngine;