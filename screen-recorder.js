/**
 * ScreenRecorderEngine - 画面・Webカメラ・マイク・システム音声を統合合成する高機能録画エンジン
 */
class ScreenRecorderEngine {
  constructor() {
    this.mediaRecorder = null;
    this.stream = null;
    this.micStream = null;
    this.cameraStream = null;
    this.pipCanvas = null;
    this.pipCtx = null;
    this.pipAnimId = null;
    this.chunks = [];
    this.timerId = null;
    this.startTime = 0;
    this.pausedTime = 0;
    this.isPaused = false;
  }

  // 画面・マイク・Webカメラを合成したストリームの生成（カメラ単体録画対応版）
  async startRecording(canvasElement, getAudioCtx, onLiveTick, onStoppedByUser) {
    const isSystemAudio = !!document.getElementById('record-system-audio-enabled')?.checked;
    const isMic = !!document.getElementById('record-mic-enabled')?.checked;
    const isCamera = !!document.getElementById('record-camera-pip-enabled')?.checked;
    const fps = parseInt(document.getElementById('record-fps')?.value) || 30;
    const sourceType = document.getElementById('record-source-type')?.value || 'monitor';

    let captureStream = null;

    // 1. 録画ソースの取得（カメラ単体 / プレビューCanvas / 画面共有）
    if (sourceType === 'camera') {
      // ★ Webカメラ映像のみをフル解像度で直接取得
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: fps } },
        audio: isMic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false
      });
      captureStream = this.cameraStream;
    } else if (sourceType === 'canvas') {
      captureStream = canvasElement.captureStream(fps);
    } else {
      captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: sourceType, frameRate: { ideal: fps, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: isSystemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
      });
    }

    // 2. 画面共有＋カメラPiP合成（カメラ単体録画時以外）
    let videoStreamToRecord = captureStream;
    if (sourceType !== 'camera' && isCamera) {
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: fps } }
        });
        videoStreamToRecord = this.createPipCompositeStream(captureStream, this.cameraStream, fps);
      } catch (camErr) {
        console.warn("カメラの取得をスキップしました:", camErr);
      }
    }

    let finalStream = videoStreamToRecord;
    const hasSysAudio = isSystemAudio && captureStream.getAudioTracks().length > 0;

    // 音声ルーティング（マイク ＋ 内部音声の高品質ミキシング）
    if (isSystemAudio || isMic) {
      const audioCtx = getAudioCtx();
      if (isMic) {
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (e) {}
      }

      if (audioCtx && (hasSysAudio || this.micStream)) {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const dest = audioCtx.createMediaStreamDestination();

        if (hasSysAudio) {
          try { audioCtx.createMediaStreamSource(captureStream).connect(dest); } catch (e) {}
        }
        if (this.micStream) {
          try { audioCtx.createMediaStreamSource(this.micStream).connect(dest); } catch (e) {}
        }

        finalStream = new MediaStream([
          ...videoStreamToRecord.getVideoTracks(),
          ...dest.stream.getAudioTracks()
        ]);
      }
    }

    this.stream = finalStream;
    this.chunks = [];
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    this.mediaRecorder = new MediaRecorder(finalStream, {
      mimeType: mime,
      videoBitsPerSecond: 8000000 // 8Mbps の高画質録画
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.start(250); // 250ms ごとにチャンクを安全フラッシュ
    this.startTime = Date.now();
    this.isPaused = false;

    this.timerId = setInterval(() => {
      if (!this.isPaused) {
        const sec = Math.floor((Date.now() - this.startTime) / 1000);
        onLiveTick(sec);
      }
    }, 500);

    const screenTrack = captureStream.getVideoTracks()[0];
    if (screenTrack) screenTrack.onended = () => onStoppedByUser();

    return finalStream;
  }

  // 画面とカメラのリアルタイムPiPワイプ合成
  createPipCompositeStream(screenStream, cameraStream, fps) {
    this.pipCanvas = document.createElement('canvas');
    this.pipCanvas.width = 1920;
    this.pipCanvas.height = 1080;
    this.pipCtx = this.pipCanvas.getContext('2d');

    this._pipScreenVideo = document.createElement('video');
    this._pipScreenVideo.srcObject = screenStream;
    this._pipScreenVideo.muted = true;
    this._pipScreenVideo.play();

    this._pipCameraVideo = document.createElement('video');
    this._pipCameraVideo.srcObject = cameraStream;
    this._pipCameraVideo.muted = true;
    this._pipCameraVideo.play();

    const drawFrame = () => {
      if (!this.pipCtx || !this._pipScreenVideo || !this._pipCameraVideo) return;
      this.pipCtx.drawImage(this._pipScreenVideo, 0, 0, this.pipCanvas.width, this.pipCanvas.height);

      // 右下に丸角カメラワイプを描画
      const cw = 420;
      const ch = 280;
      const cx = this.pipCanvas.width - cw - 40;
      const cy = this.pipCanvas.height - ch - 40;

      this.pipCtx.save();
      this.pipCtx.beginPath();
      this.pipCtx.rect(cx, cy, cw, ch);
      this.pipCtx.clip();
      this.pipCtx.drawImage(this._pipCameraVideo, cx, cy, cw, ch);
      this.pipCtx.restore();

      this.pipCtx.strokeStyle = '#00f0ff';
      this.pipCtx.lineWidth = 4;
      this.pipCtx.strokeRect(cx, cy, cw, ch);

      this.pipAnimId = requestAnimationFrame(drawFrame);
    };

    drawFrame();
    return this.pipCanvas.captureStream(fps);
  }

  // 録画の一時停止
  pauseRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
      this.isPaused = true;
    }
  }

  // 録画の再開
  resumeRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
      this.isPaused = false;
    }
  }

  // 録画停止とBlobファイル生成
  stopRecording() {
    return new Promise((resolve) => {
      if (this.timerId) { clearInterval(this.timerId); this.timerId = null; }
      if (this.pipAnimId) { cancelAnimationFrame(this.pipAnimId); this.pipAnimId = null; }

      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.onstop = () => {
          const duration = Math.max(0.5, (Date.now() - this.startTime) / 1000);
          const blob = new Blob(this.chunks, { type: 'video/webm' });
          const file = new File([blob], `ScreenRecord_${Date.now()}.webm`, { type: 'video/webm' });
          this.cleanupStreams();
          resolve({ file, duration });
        };
        this.mediaRecorder.stop();
      } else {
        this.cleanupStreams();
        resolve(null);
      }
    });
  }

  // デバイスカメラ・マイク・画面ストリームの完全切断とメモリ解放
  cleanupStreams() {
    [this.stream, this.micStream, this.cameraStream].forEach(st => {
      if (st) {
        st.getTracks().forEach(t => {
          try { t.stop(); } catch (e) {}
        });
      }
    });

    if (this._pipScreenVideo) {
      this._pipScreenVideo.pause();
      this._pipScreenVideo.srcObject = null;
      this._pipScreenVideo = null;
    }
    if (this._pipCameraVideo) {
      this._pipCameraVideo.pause();
      this._pipCameraVideo.srcObject = null;
      this._pipCameraVideo = null;
    }

    this.stream = null;
    this.micStream = null;
    this.cameraStream = null;
    this.pipCanvas = null;
    this.pipCtx = null;
  }
}

window.ScreenRecorderEngine = new ScreenRecorderEngine();