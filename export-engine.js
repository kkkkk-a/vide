/**
 * ExportEngine - 超高速ネイティブキャプチャ & FFmpeg (MP4/GIF) エンコードエンジン
 */
class ExportEngine {
  constructor() {
    this.ffmpeg = null;
  }

  // 予測サイズ・エンコード時間の計算（全音声フォーマット対応）
  static calculateEstimates(duration, width, height, format, fps, quality) {
    const isAudioOnly = ['wav', 'mp3', 'aac', 'flac', 'ogg'].includes(format);

    let estimatedMB = 0;
    let estimatedSec = 1;

    if (isAudioOnly) {
      estimatedMB = format === 'wav' ? ((duration * 44100 * 2 * 2) / (1024 * 1024)).toFixed(1) : ((duration * 192) / (8 * 1024)).toFixed(1);
      estimatedSec = Math.max(1, Math.ceil(duration * 0.05)); // 音声は瞬時
    } else {
      const pixelCount = width * height;
      let baseBitrate = (pixelCount / (1280 * 720)) * 4.0;
      if (fps === 60) baseBitrate *= 1.4;
      if (quality === 'medium') baseBitrate *= 0.7;
      if (quality === 'ultra') baseBitrate *= 1.8;
      if (format === 'gif') baseBitrate *= 0.5;

      estimatedMB = Math.max(0.5, ((baseBitrate * duration) / 8)).toFixed(1);
      const timeMultiplier = format === 'mp4' ? 0.3 : (format === 'gif' ? 1.2 : 0.1);
      estimatedSec = Math.ceil(duration * timeMultiplier);
    }

    const m = Math.floor(duration / 60).toString().padStart(2, '0');
    const s = Math.floor(duration % 60).toString().padStart(2, '0');
    const estM = Math.floor(estimatedSec / 60);
    const estS = estimatedSec % 60;
    const timeText = estM > 0 ? `約 ${estimatedSec} 秒 (${estM}分${estS}秒)` : `約 ${estimatedSec} 秒`;

    return { durationText: `${m}:${s}`, sizeText: `約 ${estimatedMB} MB`, timeText };
  }

  // ★ タイムライン上の全音声を OfflineAudioContext で完全合成
  async renderTimelineAudio(tracks, duration, volumeState = { video: 1, bgm: 1, pitch: 1, isMuted: false }) {
    if (volumeState.isMuted || duration <= 0) return null;

    const sampleRate = 44100;
    const totalFrames = Math.ceil(Math.max(0.5, duration) * sampleRate);
    const OfflineCtxClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtxClass) return null;

    const offlineCtx = new OfflineCtxClass(2, totalFrames, sampleRate);
    let hasAudioTrack = false;

    for (const track of tracks) {
      if (track.hidden || (track.type !== 'video' && track.type !== 'audio')) continue;
      if (track.type === 'video' && track.isAudioSeparated) continue; // 音声分離済みの動画映像はスキップ
      if (!track.element?.src) continue;

      try {
        const res = await fetch(track.element.src);
        const arrayBuf = await res.arrayBuffer();
        const decodedBuf = await offlineCtx.decodeAudioData(arrayBuf);

        const srcNode = offlineCtx.createBufferSource();
        srcNode.buffer = decodedBuf;

        // 再生速度（ピッチ）
        const playbackRate = volumeState.pitch || 1.0;
        srcNode.playbackRate.value = playbackRate;

        // 音量ゲイン ＆ フェード処理
        const gainNode = offlineCtx.createGain();
        const baseVol = track.type === 'video' ? volumeState.video : volumeState.bgm;
        const customGain = track.customVolume !== undefined ? track.customVolume : 1.0;
        const targetVol = Math.max(0, Math.min(2.0, baseVol * customGain));

        const startT = track.startTime || 0;
        const dur = track.duration || 5;
        const fadeIn = track.audioFadeIn || 0;
        const fadeOut = track.audioFadeOut || 0;

        gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : targetVol, startT);
        if (fadeIn > 0) {
          gainNode.gain.linearRampToValueAtTime(targetVol, startT + fadeIn);
        }
        if (fadeOut > 0) {
          gainNode.gain.setValueAtTime(targetVol, startT + dur - fadeOut);
          gainNode.gain.linearRampToValueAtTime(0.001, startT + dur);
        }

        // ★ オフライン音声合成時の 3バンドEQ
        const eq = track.eq || { low: 0, mid: 0, high: 0 };
        const lowF = offlineCtx.createBiquadFilter();
        lowF.type = 'lowshelf';
        lowF.frequency.value = 100;
        lowF.gain.value = eq.low || 0;

        const midF = offlineCtx.createBiquadFilter();
        midF.type = 'peaking';
        midF.frequency.value = 1000;
        midF.Q.value = 1.0;
        midF.gain.value = eq.mid || 0;

        const highF = offlineCtx.createBiquadFilter();
        highF.type = 'highshelf';
        highF.frequency.value = 8000;
        highF.gain.value = eq.high || 0;

        srcNode.connect(lowF);
        lowF.connect(midF);
        midF.connect(highF);

        // ★ 音圧コンプレッサー
        if (track.compressorEnabled) {
          const comp = offlineCtx.createDynamicsCompressor();
          comp.threshold.value = -20;
          comp.ratio.value = 4;
          highF.connect(comp);
          comp.connect(gainNode);
        } else {
          highF.connect(gainNode);
        }

        gainNode.connect(offlineCtx.destination);

        const offset = Math.max(0, track.mediaOffset || 0);
        const maxAvailableBufferTime = Math.max(0, decodedBuf.duration - offset);
        const playDuration = Math.min(dur * playbackRate, maxAvailableBufferTime);

        if (playDuration > 0.01) {
          srcNode.start(startT, offset, playDuration);
          hasAudioTrack = true;
        }
      } catch (err) {
        console.warn("音声トラックの合成をスキップ:", track.name, err);
      }
    }

    if (!hasAudioTrack) return null;
    return await offlineCtx.startRendering();
  }

  // 安全な Blob URL 変換ユーティリティ
  static async toBlobURLSafe(url, mimeType) {
    if (window.FFmpegUtil?.toBlobURL) {
      try {
        return await window.FFmpegUtil.toBlobURL(url, mimeType);
      } catch (e) {}
    }
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  }

  // 安全な File/Blob -> Uint8Array 変換
  static async fetchFileSafe(fileOrBlob) {
    const fetchFn = window.FFmpegUtil?.fetchFile || window.FFmpegWASM?.fetchFile;
    if (fetchFn) {
      try {
        return await fetchFn(fileOrBlob);
      } catch (e) {}
    }
    if (fileOrBlob instanceof Blob) {
      return new Uint8Array(await fileOrBlob.arrayBuffer());
    }
    const res = await fetch(fileOrBlob);
    return new Uint8Array(await res.arrayBuffer());
  }

  // FFmpeg インスタンス初期化 (ローカルESM自動パッチ + CDN ESMフォールバック)
  async getFFmpeg(onProgress) {
    if (this.ffmpeg) return this.ffmpeg;

    const FFmpegClass = window.FFmpegWASM?.FFmpeg || window.FFmpeg?.FFmpeg || window.FFmpeg;
    if (!FFmpegClass) {
      throw new Error("FFmpeg ライブラリが読み込まれていません。");
    }

    const ffmpeg = new FFmpegClass();
    ffmpeg.on('log', ({ message }) => {
    });

    if (onProgress) {
      ffmpeg.on('progress', ({ progress }) => {
        const pct = Math.min(99, Math.max(1, Math.round(progress * 100)));
        onProgress(`MP4変換エンコード中... ${pct}%`);
      });
    }

    const baseURL = new URL('./ffmpeg-lib/', window.location.href).href;

    try {
      const coreRes = await fetch(`${baseURL}ffmpeg-core.js`);
      if (coreRes.ok) {
        let coreCode = await coreRes.text();
        if (!coreCode.includes('export default') && !coreCode.includes('export {')) {
          coreCode += '\n;if(typeof createFFmpegCore!=="undefined"){self.createFFmpegCore=createFFmpegCore;}\nexport default createFFmpegCore;\n';
        }

        const coreBlob = new Blob([coreCode], { type: 'text/javascript' });
        const coreURL = URL.createObjectURL(coreBlob);
        const wasmURL = await ExportEngine.toBlobURLSafe(`${baseURL}ffmpeg-core.wasm`, 'application/wasm');

        let classWorkerURL = undefined;
        try {
          const wRes = await fetch(`${baseURL}814.ffmpeg.js`);
          if (wRes.ok) {
            classWorkerURL = URL.createObjectURL(new Blob([await wRes.text()], { type: 'text/javascript' }));
          }
        } catch (e) {}

        await ffmpeg.load({
          coreURL,
          wasmURL,
          ...(classWorkerURL ? { classWorkerURL } : {})
        });

        this.ffmpeg = ffmpeg;
        return this.ffmpeg;
      }
    } catch (localErr) {
      console.warn("ローカル ffmpeg-core の読み込みに失敗、CDN (ESM版) を試行:", localErr);
    }

    const cdnBase = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/';
    await ffmpeg.load({
      coreURL: await ExportEngine.toBlobURLSafe(`${cdnBase}ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await ExportEngine.toBlobURLSafe(`${cdnBase}ffmpeg-core.wasm`, 'application/wasm')
    });

    this.ffmpeg = ffmpeg;
    return this.ffmpeg;
  }

  // 高速 MP4 変換 (フリーズ防止: -t 秒数指定 & 最速設定)
  async convertToMP4(webmBlob, duration, onProgress) {
    const ffmpeg = await this.getFFmpeg(onProgress);
    const fileData = await ExportEngine.fetchFileSafe(webmBlob);
    const durStr = Math.max(0.5, Number(duration || 1)).toFixed(2);

    try {
      await ffmpeg.writeFile('input.webm', fileData);
      
      // ★ フリーズ対策: -t で長さを強制制限 & -threads 0 & ultrafast
      await ffmpeg.exec([
        '-fflags', '+genpts',
        '-r', '30',
        '-i', 'input.webm',
        '-t', durStr,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-movflags', '+faststart',
        'output.mp4'
      ]);

      const data = await ffmpeg.readFile('output.mp4');
      return new Blob([data], { type: 'video/mp4' });
    } finally {
      try { await ffmpeg.deleteFile('input.webm'); } catch (e) {}
      try { await ffmpeg.deleteFile('output.mp4'); } catch (e) {}
    }
  }

  // GIF 変換
  async convertToGIF(webmBlob, duration, onProgress) {
    const ffmpeg = await this.getFFmpeg(onProgress);
    const fileData = await ExportEngine.fetchFileSafe(webmBlob);
    const durStr = Math.max(0.5, Number(duration || 1)).toFixed(2);

    try {
      await ffmpeg.writeFile('input.webm', fileData);
      await ffmpeg.exec([
        '-i', 'input.webm',
        '-t', durStr,
        '-vf', 'fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        'output.gif'
      ]);
      const data = await ffmpeg.readFile('output.gif');
      return new Blob([data], { type: 'image/gif' });
    } finally {
      try { await ffmpeg.deleteFile('input.webm'); } catch (e) {}
      try { await ffmpeg.deleteFile('output.gif'); } catch (e) {}
    }
  }

  // ダウンロードトリガー
  static triggerDownload(blob, filename) {
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
    }, 5000);
  }

  // ★ 現在のフレームをサムネイル画像（PNG / JPG / WebP）として即座にダウンロード
  static exportThumbnail(canvas, format = 'png', filename = 'thumbnail') {
    const mimeType = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : (format === 'webp' ? 'image/webp' : 'image/png');
    const ext = format === 'jpg' || format === 'jpeg' ? 'jpg' : format;

    canvas.toBlob((blob) => {
      if (blob) {
        ExportEngine.triggerDownload(blob, `${filename}.${ext}`);
      }
    }, mimeType, 0.95);
  }

  // キャプチャと書き出しの実行
  async captureAndExport(canvas, tracks, duration, options, callbacks) {
    const { fps = 30, format = 'mp4', filename = 'my-video' } = options;
    const { onProgress, onTimeUpdate, audioCtx } = callbacks;

    const stream = canvas.captureStream(fps);
    let exportDestNode = null;
    const connectedSources = [];

    if (audioCtx) {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      exportDestNode = audioCtx.createMediaStreamDestination();

      tracks.forEach(t => {
        if ((t.type === 'video' || t.type === 'audio') && t.element && !t.isAudioSeparated && !t.hidden) {
          try {
            if (!t.element._mediaElementSourceNode) {
              t.element._mediaElementSourceNode = t._audioNodes?.source || audioCtx.createMediaElementSource(t.element);
            }
            if (!t.element._mediaGainNode) {
              t.element._mediaGainNode = audioCtx.createGain();
              t.element._mediaElementSourceNode.connect(t.element._mediaGainNode);
            }
            try { t.element._mediaGainNode.disconnect(); } catch (e) {}
            t.element._mediaGainNode.connect(exportDestNode);
            connectedSources.push(t.element._mediaGainNode);
          } catch (e) {}
        }
      });

      if (connectedSources.length > 0) {
        const audioTrack = exportDestNode.stream.getAudioTracks()[0];
        if (audioTrack) stream.addTrack(audioTrack);
      }
    }

    // ★ 合成済み音声トラック（options.audioStreamTrack）が渡されている場合は確実に映像ストリームへ合流
    if (options.audioStreamTrack) {
      stream.addTrack(options.audioStreamTrack);
    }

    // ★ MP4選択時はブラウザのネイティブ MP4 レコーダーを最優先（Chrome/Safariなら即時完了）
    let mimeTypes = [];
    if (format === 'mp4') {
      mimeTypes = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ];
    } else {
      mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
      ];
    }

    const selectedMime = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = selectedMime ? new MediaRecorder(stream, { mimeType: selectedMime }) : new MediaRecorder(stream);
    const chunks = [];

    recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

    return new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        connectedSources.forEach(src => {
          try { src.disconnect(exportDestNode); } catch (e) {}
          if (audioCtx) try { src.connect(audioCtx.destination); } catch (e) {}
        });
        if (exportDestNode) try { exportDestNode.disconnect(); } catch (e) {}
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}

        const rawBlob = new Blob(chunks, { type: selectedMime || 'video/webm' });

        if (!rawBlob || rawBlob.size < 1000) {
          const err = new Error(`映像フレームが記録されませんでした (データサイズ: ${rawBlob ? rawBlob.size : 0} bytes)`);
          console.error("書き出し中止:", err);
          reject(err);
          return;
        }

        const isAlreadyMP4 = (selectedMime && selectedMime.includes('mp4'));

        // すでにネイティブ MP4 の場合はエンコード不要で即ダウンロード
        if (format === 'mp4' && isAlreadyMP4) {
          onProgress("MP4書き出し完了！ダウンロード中...");
          ExportEngine.triggerDownload(rawBlob, `${filename}.mp4`);
          resolve();
          return;
        }

        // WebM そのままの指定の場合も即ダウンロード
        if (format === 'webm') {
          onProgress("WebM書き出し完了！ダウンロード中...");
          ExportEngine.triggerDownload(rawBlob, `${filename}.webm`);
          resolve();
          return;
        }

        // FFmpeg での動画変換処理 (MP4 / MOV / AVI / MKV / AMV / GIF)
        try {
          let finalBlob = rawBlob;
          let ext = format;

          if (format === 'mp4') {
            onProgress("MP4変換中... 0%");
            finalBlob = await this.convertToMP4(rawBlob, duration, onProgress);
            ext = 'mp4';
          } else if (format === 'gif') {
            onProgress("GIF変換中... 0%");
            finalBlob = await this.convertToGIF(rawBlob, duration, onProgress);
            ext = 'gif';
          } else {
            // MOV, AVI, MKV, AMV への自在トランスコード
            onProgress(`${format.toUpperCase()} 変換エンコード中... 0%`);
            const ffmpeg = await this.getFFmpeg(onProgress);
            const fileData = await ExportEngine.fetchFileSafe(rawBlob);
            await ffmpeg.writeFile('input.webm', fileData);

            const outName = `output.${format}`;
            let ffmpegArgs = ['-i', 'input.webm', '-t', String(duration)];

            if (format === 'mov') {
              ffmpegArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outName);
            } else if (format === 'avi') {
              ffmpegArgs.push('-c:v', 'mjpeg', '-q:v', '3', outName);
            } else if (format === 'amv') {
              // AMV: アニメ動画用プロファイル
              ffmpegArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', outName);
            } else { // mkv
              ffmpegArgs.push('-c:v', 'copy', outName);
            }

            await ffmpeg.exec(ffmpegArgs);
            const outData = await ffmpeg.readFile(outName);
            finalBlob = new Blob([outData]);
            ext = format;
          }

          ExportEngine.triggerDownload(finalBlob, `${filename}.${ext}`);
          resolve();
        } catch (err) {
          console.error("エンコードエラー。録画済みWebMとして救出保存:", err);
          ExportEngine.triggerDownload(rawBlob, `${filename}.webm`);
          alert("MP4変換中にエラーが発生したため、録画されたWebM動画として保存しました。");
          resolve();
        }
      };

      recorder.onerror = err => reject(err);
      recorder.start(100);

      Promise.resolve(onTimeUpdate(recorder)).catch(err => {
        console.error("フレーム描画中エラー:", err);
        if (recorder.state === 'recording') recorder.stop();
      });
    });
  }

async exportOfflineFrames(canvas, tracks, duration, options, callbacks, renderFrameFn) {
    const { onProgress, audioCtx } = callbacks;
    const { fps = 30, format = 'mp4', filename = 'my-video' } = options;

    // 1. 音声トラックをオフライン合成
    onProgress("音声をレンダリング中...");
    const renderedAudioBuffer = await this.renderTimelineAudio(tracks, duration, window.editor?.state?.volume);

    // 2. 音声専用フォーマット書き出し
    const audioFormats = ['wav', 'mp3', 'aac', 'flac', 'ogg'];
    if (audioFormats.includes(format)) {
      if (!renderedAudioBuffer) throw new Error("タイムライン上に有効な音声がありません。");
      onProgress(`${format.toUpperCase()} をエンコード中...`);
      const wavBlob = window.editor.synthEngine.audioBufferToWavBlob(renderedAudioBuffer);

      if (format === 'wav') {
        ExportEngine.triggerDownload(wavBlob, `${filename}.wav`);
      } else {
        const ffmpeg = await this.getFFmpeg(onProgress);
        const fileData = await ExportEngine.fetchFileSafe(wavBlob);
        await ffmpeg.writeFile('audio.wav', fileData);

        const extMap = {
          mp3: ['-b:a', '320k', 'output.mp3'],
          aac: ['-c:a', 'aac', '-b:a', '256k', 'output.m4a'],
          flac: ['-c:a', 'flac', 'output.flac'],
          ogg: ['-c:a', 'libvorbis', '-q:a', '6', 'output.ogg']
        };
        const args = ['-i', 'audio.wav', ...(extMap[format] || extMap.mp3)];
        const outFileName = args[args.length - 1];

        await ffmpeg.exec(args);
        const outData = await ffmpeg.readFile(outFileName);
        const outExt = format === 'aac' ? 'm4a' : format;
        ExportEngine.triggerDownload(new Blob([outData]), `${filename}.${outExt}`);
      }
      onProgress("書き出し完了！");
      return;
    }

    // 3. 動画素材の取得とシーク準備
    const videoTracks = tracks.filter(t => t.type === 'video' && t.element && !t.hidden);
    const pitch = window.editor?.state?.volume?.pitch || 1.0;

    // 4. 連番JPEGフレームの確実な生成とFFmpegへの転送
    const ffmpeg = await this.getFFmpeg(onProgress);
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const width = (canvas.width & ~1); // 偶数幅
    const height = (canvas.height & ~1); // 偶数高さ

    let exportCanvas = canvas;
    let exportCtx = null;
    if (width !== canvas.width || height !== canvas.height) {
      exportCanvas = document.createElement('canvas');
      exportCanvas.width = width;
      exportCanvas.height = height;
      exportCtx = exportCanvas.getContext('2d');
    }

    const createdFrameFiles = [];

    try {
      for (let f = 0; f < totalFrames; f++) {
        const curSec = Math.min(duration, f / fps);

        // 動画素材がある場合、各動画のシーク完了を待機
        if (videoTracks.length > 0) {
          await Promise.all(videoTracks.map(t => {
            const el = t.element;
            const inRange = curSec >= t.startTime && curSec <= (t.startTime + t.duration);
            if (!inRange) return Promise.resolve();

            const offset = t.mediaOffset || 0;
            const targetTime = Math.max(0, (offset + (curSec - t.startTime)) * pitch);
            const maxDur = el.duration || Infinity;
            const safeTime = Math.min(targetTime, isFinite(maxDur) ? maxDur - 0.05 : targetTime);

            if (Math.abs(el.currentTime - safeTime) < 0.02) return Promise.resolve();

            return new Promise(res => {
              const onSeeked = () => {
                el.removeEventListener('seeked', onSeeked);
                res();
              };
              el.addEventListener('seeked', onSeeked, { once: true });
              el.currentTime = safeTime;
              setTimeout(res, 80); // タイムアウト保護
            });
          }));
        }

        renderFrameFn(curSec);

        if (exportCtx) {
          exportCtx.drawImage(canvas, 0, 0, width, height);
        }

        // CanvasをJPEGバイナリとして取得
        const frameBlob = await new Promise(r => exportCanvas.toBlob(r, 'image/jpeg', 0.92));
        const frameData = new Uint8Array(await frameBlob.arrayBuffer());
        const frameName = `f_${String(f).padStart(6, '0')}.jpg`;

        await ffmpeg.writeFile(frameName, frameData);
        createdFrameFiles.push(frameName);

        const pct = Math.round(((f + 1) / totalFrames) * 70);
        onProgress(`フレームレンダリング中... ${pct}% (${f + 1}/${totalFrames})`);
      }

      // 音声WAVの書き込み
      let hasAudio = false;
      if (renderedAudioBuffer && window.editor?.synthEngine) {
        const wavBlob = window.editor.synthEngine.audioBufferToWavBlob(renderedAudioBuffer);
        const audioData = await ExportEngine.fetchFileSafe(wavBlob);
        await ffmpeg.writeFile('audio.wav', audioData);
        hasAudio = true;
      }

      onProgress("動画をエンコード・結合中... (80%)");

      const outFileName = `output.${format}`;
      const ffmpegArgs = [
        '-framerate', String(fps),
        '-i', 'f_%06d.jpg'
      ];

      if (hasAudio) {
        ffmpegArgs.push('-i', 'audio.wav');
      }

      if (format === 'mp4') {
        ffmpegArgs.push(
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-pix_fmt', 'yuv420p',
          '-crf', '23'
        );
        if (hasAudio) {
          ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
        }
        ffmpegArgs.push('-movflags', '+faststart', outFileName);
      } else if (format === 'webm') {
        ffmpegArgs.push(
          '-c:v', 'libvpx',
          '-b:v', '3M',
          '-pix_fmt', 'yuv420p'
        );
        if (hasAudio) {
          ffmpegArgs.push('-c:a', 'libvorbis', '-shortest');
        }
        ffmpegArgs.push(outFileName);
      } else if (format === 'gif') {
        ffmpegArgs.push(
          '-vf', `fps=${Math.min(15, fps)},scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
          outFileName
        );
      } else {
        ffmpegArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outFileName);
      }

      await ffmpeg.exec(ffmpegArgs);
      const outputData = await ffmpeg.readFile(outFileName);

      const mimeMap = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif' };
      const resultBlob = new Blob([outputData], { type: mimeMap[format] || 'video/mp4' });

      ExportEngine.triggerDownload(resultBlob, `${filename}.${format}`);
      onProgress("書き出し完了！");
    } finally {
      // 一時連番ファイルの削除
      for (const fn of createdFrameFiles) {
        try { await ffmpeg.deleteFile(fn); } catch (e) {}
      }
      try { await ffmpeg.deleteFile('audio.wav'); } catch (e) {}
      try { await ffmpeg.deleteFile(`output.${format}`); } catch (e) {}
    }
  }
}

window.ExportEngine = new ExportEngine();