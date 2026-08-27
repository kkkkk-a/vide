/**
 * AudioSynthEngine - Web Audio API プロ品質 音楽・効果音ジェネレーター
 * BGM自動作曲・FMシンセ・ADSRエンベロープ・エフェクター・WAV書き出し完備
 */
class AudioSynthEngine {
  constructor(audioCtx = null, wasmCore = null) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = audioCtx || new AudioContextClass();
    this.wasmCore = wasmCore;
    this.currentSourceNodes = [];
    this.smTimerId = null;
    this.isSmPlaying = false;
    this.smCurrentStep = 0;
  }

  // ★ Song Maker シーケンサーのループ再生管理
  startSequencerLoop(config, onStepTick) {
    this.stopSequencerLoop();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const { melodyGrid, drumGrid, scaleFreqs, bpm, instrument, drumKit, totalSteps } = config;
    this.isSmPlaying = true;
    this.smCurrentStep = 0;

    const stepIntervalMs = ((60 / bpm) / 4) * 1000;
    const melodyRows = scaleFreqs.length;

    this.smTimerId = setInterval(() => {
      if (!this.isSmPlaying) return;

      const currentTotalSteps = melodyGrid[0] ? melodyGrid[0].length : totalSteps;
      if (this.smCurrentStep >= currentTotalSteps) {
        this.smCurrentStep = 0;
      }

      // UIコールバック（現在ステップのハイライト更新）
      if (typeof onStepTick === 'function') {
        onStepTick(this.smCurrentStep);
      }

      // メロディ発音
      for (let r = 0; r < melodyRows; r++) {
        if (melodyGrid[r] && melodyGrid[r][this.smCurrentStep]) {
          this.playSongMakerTone(scaleFreqs[r], instrument);
        }
      }

      // ドラム発音
      if (drumGrid[0] && drumGrid[0][this.smCurrentStep]) this.playSongMakerDrum('snare', drumKit);
      if (drumGrid[1] && drumGrid[1][this.smCurrentStep]) this.playSongMakerDrum('kick', drumKit);

      this.smCurrentStep = (this.smCurrentStep + 1) % currentTotalSteps;
    }, stepIntervalMs);
  }

  // ★ Song Maker シーケンサーの安全停止
  stopSequencerLoop() {
    this.isSmPlaying = false;
    if (this.smTimerId) {
      clearInterval(this.smTimerId);
      this.smTimerId = null;
    }
    this.smCurrentStep = 0;
  }

  setWasmCore(wasmCore) {
    this.wasmCore = wasmCore;
  }

  // 1. 効果音 (SE) プリセット即時生成 (FM音源・ステレオ感・エンベロープ最適化)
  generateSoundEffect(type = 'coin') {
    const sampleRate = this.ctx.sampleRate;
    let duration = 0.5;

    if (type === 'laser') duration = 0.35;
    else if (type === 'explosion') duration = 1.4;
    else if (type === 'jump') duration = 0.32;
    else if (type === 'click') duration = 0.06;
    else if (type === 'powerup') duration = 0.85;
    else if (type === 'hit') duration = 0.3;
    else if (type === 'whoosh') duration = 0.45;

    const buffer = this.ctx.createBuffer(2, Math.floor(sampleRate * duration), sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    let phase = 0;
    for (let i = 0; i < left.length; i++) {
      const t = i / sampleRate;
      let sampleL = 0;
      let sampleR = 0;

      if (type === 'coin') {
        // コイン音 (ピロリン): 2音のベルFMシンセ
        const freq = t < 0.09 ? 987.77 : 1318.51; // B5 -> E6
        phase += (2 * Math.PI * freq) / sampleRate;
        const env = Math.exp(-t * 8);
        const mod = Math.sin(phase * 2) * 0.3;
        const s = (Math.sin(phase + mod) + Math.sin(phase * 3) * 0.2) * env * 0.45;
        sampleL = s * 0.6;
        sampleR = s * 0.4;
      } else if (type === 'laser') {
        // レーザー音: 急降下指数FM (位相累積)
        const freq = 1200 * Math.exp(-t * 18) + 60;
        phase += freq / sampleRate;
        const env = Math.exp(-t * 7);
        const s = (2 * (phase % 1.0) - 1.0) * env * 0.4;
        sampleL = s * 0.7;
        sampleR = s * 0.3;
      } else if (type === 'jump') {
        // ジャンプ音: 放物線ピッチ上昇 (位相累積)
        const freq = 140 + Math.pow(t / duration, 0.5) * 550;
        phase += (2 * Math.PI * freq) / sampleRate;
        const env = Math.exp(-t * 4.5);
        const s = Math.sin(phase) * env * 0.5;
        sampleL = s;
        sampleR = s;
      } else if (type === 'explosion') {
        // 爆発音: サブベースキック + ローパスノイズ減衰（位相累積）
        const freq = 90 * Math.exp(-t * 12) + 20;
        phase += (2 * Math.PI * freq) / sampleRate;
        const noise = (Math.random() * 2 - 1) * Math.exp(-t * 3.2);
        const sub = Math.sin(phase) * Math.exp(-t * 4.0) * 0.7;
        sampleL = (noise * 0.5 + sub) * 0.8;
        sampleR = (noise * 0.5 + sub) * 0.8;
      } else if (type === 'click') {
        // UIクリック音: 微小インパルス
        const s = Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t * 90) * 0.4;
        sampleL = s;
        sampleR = s;
      } else if (type === 'powerup') {
        // パワーアップ音: メジャーアルペジオの上昇（位相累積でクリックノイズ完全防止）
        const noteIdx = Math.min(5, Math.floor(t * 10));
        const freqs = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99]; // C E G C E G
        const freq = freqs[noteIdx];
        phase += (2 * Math.PI * freq) / sampleRate;
        const env = Math.exp(-((t * 10) % 1) * 4);
        const s = (Math.sin(phase) + Math.sin(phase * 2) * 0.3) * env * 0.35;
        sampleL = s * (0.3 + noteIdx * 0.1);
        sampleR = s * (0.8 - noteIdx * 0.1);
      } else if (type === 'hit') {
        // 打撃音: 808アタック + トーン（位相累積）
        const freq = 110 * Math.exp(-t * 16) + 30;
        phase += (2 * Math.PI * freq) / sampleRate;
        const noise = (Math.random() * 2 - 1) * Math.exp(-t * 22) * 0.4;
        const body = Math.sin(phase) * Math.exp(-t * 10) * 0.6;
        sampleL = (noise + body);
        sampleR = (noise + body);
      } else if (type === 'whoosh') {
        // 風切り音 (トランジション・スライド用)
        const p = t / duration;
        const env = Math.sin(p * Math.PI);
        const noise = (Math.random() * 2 - 1) * env * 0.35;
        sampleL = noise * (1.0 - p);
        sampleR = noise * p;
      }

      left[i] = Math.max(-0.95, Math.min(0.95, sampleL));
      right[i] = Math.max(-0.95, Math.min(0.95, sampleR));
    }

    return buffer;
  }

  // 2. BGM自動作曲エンジン (Rust Wasm 高速生成 ＆ JS フォールバック)
  generateBGM(genre = 'lofi', bars = 4, bpm = 85) {
    const sampleRate = this.ctx.sampleRate;

    // ★ Rust (Wasm) が利用可能な場合は超高速に高品質レンダリング
    if (this.wasmCore && this.wasmCore.render_complete_music) {
      try {
        const rawPcm = this.wasmCore.render_complete_music(genre, bpm, bars, sampleRate);
        const numFrames = Math.floor(rawPcm.length / 2);
        const buffer = this.ctx.createBuffer(2, numFrames, sampleRate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);

        for (let i = 0; i < numFrames; i++) {
          left[i] = rawPcm[i * 2];
          right[i] = rawPcm[i * 2 + 1];
        }
        return buffer;
      } catch (err) {
        console.warn("Wasm BGM生成エラーのためJSにフォールバックします:", err);
      }
    }

    // JS フォールバック処理
    const secondsPerBeat = 60 / bpm;
    const totalBeats = bars * 4;
    const duration = totalBeats * secondsPerBeat;
    const totalSamples = Math.floor(sampleRate * duration);

    const buffer = this.ctx.createBuffer(2, totalSamples, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const chordProgressions = {
      lofi: [
        [261.63, 329.63, 392.00, 493.88],
        [220.00, 261.63, 329.63, 392.00],
        [174.61, 220.00, 261.63, 329.63],
        [196.00, 246.94, 293.66, 349.23]
      ],
      synthwave: [
        [110.00, 164.81, 220.00],
        [87.31, 130.81, 174.61],
        [130.81, 196.00, 261.63],
        [98.00, 146.83, 196.00]
      ],
      chiptune: [
        [261.63, 329.63, 392.00],
        [196.00, 246.94, 293.66],
        [220.00, 261.63, 329.63],
        [174.61, 220.00, 261.63]
      ],
      ambient: [
        [130.81, 196.00, 293.66, 392.00],
        [110.00, 164.81, 261.63, 329.63],
        [87.31, 130.81, 220.00, 261.63],
        [98.00, 146.83, 246.94, 293.66]
      ]
    };

    const chords = chordProgressions[genre] || chordProgressions.lofi;

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      const currentBeat = (t / secondsPerBeat);
      const currentBar = Math.floor(currentBeat / 4) % bars;
      const currentChord = chords[currentBar % chords.length];

      let mixedL = 0;
      let mixedR = 0;

      // サイドチェイン・ダッキング
      const beatFraction = currentBeat % 1.0;
      const beatNum = Math.floor(currentBeat) % 4;
      let ducking = 1.0;
      if (beatNum === 0 || beatNum === 2) {
        const kickRel = beatFraction * secondsPerBeat;
        if (kickRel < 0.32) {
          ducking = Math.min(1.0, Math.max(0.15, Math.pow(kickRel / 0.32, 0.5)));
        }
      }

      currentChord.forEach((freq, idx) => {
        const pan = (idx % 2 === 0) ? -0.25 : 0.25;
        let wave = 0;
        if (genre === 'chiptune') {
          wave = (Math.sin(2 * Math.PI * freq * t) > 0 ? 0.12 : -0.12);
        } else if (genre === 'synthwave') {
          const saw1 = 2 * ((t * freq) % 1) - 1;
          const saw2 = 2 * ((t * (freq * 1.005)) % 1) - 1;
          wave = (saw1 + saw2) * 0.08;
        } else {
          wave = (Math.sin(2 * Math.PI * freq * t) + Math.sin(2 * Math.PI * freq * 2 * t) * 0.28) * 0.12;
        }
        mixedL += wave * (0.5 - pan) * ducking;
        mixedR += wave * (0.5 + pan) * ducking;
      });

      // サブベース (ルート音)
      const rootFreq = currentChord[0] / 2;
      const bassWave = (Math.sin(2 * Math.PI * rootFreq * t) * 0.35) * ducking;
      mixedL += bassWave;
      mixedR += bassWave;

      // 808 キックドラム（未使用変数を削除し、解析積分による連続位相計算に一本化）
      if (beatNum === 0 || beatNum === 2) {
        const kickT = beatFraction * secondsPerBeat;
        if (kickT < 0.28) {
          const kickPhase = 2 * Math.PI * ((130 * (1 - Math.exp(-kickT * 28)) / 28) + 40 * kickT);
          const kickWave = Math.sin(kickPhase) * Math.exp(-kickT * 11) * 0.55;
          mixedL += kickWave;
          mixedR += kickWave;
        }
      }

      // スネアドラム (トーン + ノイズ)
      if ((beatNum === 1 || beatNum === 3) && genre !== 'ambient') {
        const snareT = beatFraction * secondsPerBeat;
        if (snareT < 0.22) {
          const noise = (Math.random() * 2 - 1) * Math.exp(-snareT * 22) * 0.35;
          const tone = Math.sin(2 * Math.PI * 180 * snareT) * Math.exp(-snareT * 30) * 0.25;
          mixedL += (noise + tone);
          mixedR += (noise + tone);
        }
      }

      left[i] = Math.max(-0.95, Math.min(0.95, mixedL));
      right[i] = Math.max(-0.95, Math.min(0.95, mixedR));
    }

    return buffer;
  }

  // 3. AudioBuffer を WAV Blob に変換（ダウンロード & 動画エディタ読み込み用）
  audioBufferToWavBlob(audioBuffer) {
    const numOfChan = audioBuffer.numberOfChannels;
    const length = audioBuffer.length * numOfChan * 2 + 44;
    const outBuffer = new ArrayBuffer(length);
    const view = new DataView(outBuffer);
    const channels = [];
    let sample = 0;
    let offset = 0;
    let pos = 0;

    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8);
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt "
    setUint32(16);
    setUint16(1); // PCM
    setUint16(numOfChan);
    setUint32(audioBuffer.sampleRate);
    setUint32(audioBuffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2);
    setUint16(16);
    setUint32(0x61746164); // "data"
    setUint32(length - pos - 4);

    for (let i = 0; i < numOfChan; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    const totalSamples = audioBuffer.length;
    while (pos < length && offset < totalSamples) {
      for (let i = 0; i < numOfChan; i++) {
        const rawSample = channels[i][offset] || 0;
        sample = Math.max(-1, Math.min(1, rawSample));
        const pcm16 = sample < 0 ? Math.floor(sample * 32768) : Math.floor(sample * 32767);
        view.setInt16(pos, Math.max(-32768, Math.min(32767, pcm16)), true);
        pos += 2;
      }
      offset++;
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  // 試聴プレビュー再生 (自動再開 & 切断保証)
  playPreview(audioBuffer) {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.stopPreview();

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.ctx.destination);

    src.onended = () => {
      try { src.disconnect(); } catch (e) {}
      this.currentSourceNodes = this.currentSourceNodes.filter(node => node !== src);
    };

    src.start(0);
    this.currentSourceNodes.push(src);
  }

  stopPreview() {
    this.currentSourceNodes.forEach(node => {
      try {
        node.stop();
        node.disconnect();
      } catch (e) {}
    });
    this.currentSourceNodes = [];
  }

  // ★ Song Maker: 単音プレビュー発音 (マス目タップ時: フィルターエンベロープ & FM搭載)
  playSongMakerTone(freq, instrument = 'marimba') {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    let stopTime = now + 0.36;

    if (instrument === 'marimba') {
      osc.type = 'sine';
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(freq * 3.5, now);
      filter.frequency.exponentialRampToValueAtTime(freq * 0.8, now + 0.25);
      gain.gain.setValueAtTime(0.40, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      stopTime = now + 0.36;
    } else if (instrument === 'synth') {
      osc.type = 'sawtooth';
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(freq * 6.0, now);
      filter.frequency.exponentialRampToValueAtTime(freq * 1.2, now + 0.40);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      stopTime = now + 0.46;
    } else if (instrument === 'piano') {
      osc.type = 'triangle';
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(freq * 4.0, now);
      filter.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.55);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.60);
      stopTime = now + 0.61;
    } else { // chiptune (8-bit)
      osc.type = 'square';
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(8000, now);
      gain.gain.setValueAtTime(0.20, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      stopTime = now + 0.29;
    }

    osc.frequency.setValueAtTime(freq, now);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    // 発音終了時にオーディオグラフから安全に切断してメモリ解放
    osc.onended = () => {
      try {
        osc.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch (e) {}
    };

    osc.start(now);
    osc.stop(stopTime);
  }

  // Song Maker: ドラム単音プレビュー発音 (電子 / 生ドラム)
  playSongMakerDrum(type = 'kick', kit = 'electronic') {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    const now = this.ctx.currentTime;
    if (type === 'kick') {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const startFreq = kit === 'electronic' ? 140 : 90;
      const decay = Math.max(0.05, kit === 'electronic' ? 0.24 : 0.16);
      osc.frequency.setValueAtTime(startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(0.01, now + decay);
      gain.gain.setValueAtTime(0.65, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch (e) {}
      };

      osc.start(now);
      osc.stop(now + decay);
    } else { // snare
      const bufferSize = Math.floor(this.ctx.sampleRate * 0.15);
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const whiteNoise = this.ctx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = kit === 'electronic' ? 'highpass' : 'bandpass';
      filter.frequency.setValueAtTime(kit === 'electronic' ? 1200 : 800, now);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.38, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      whiteNoise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);

      whiteNoise.onended = () => {
        try {
          whiteNoise.disconnect();
          filter.disconnect();
          gain.disconnect();
        } catch (e) {}
      };

      whiteNoise.start(now);
      whiteNoise.stop(now + 0.15);
    }
  }

  // ★ Song Maker: グリッドデータ全体を AudioBuffer にレンダリング (WAV書き出し用)
  renderSongMakerBuffer(melodyGrid, drumGrid, scaleFreqs, bpm = 120, instrument = 'marimba', drumKit = 'electronic') {
    const sampleRate = this.ctx.sampleRate;
    const totalSteps = (melodyGrid && melodyGrid.length > 0 && melodyGrid[0]) 
      ? melodyGrid[0].length 
      : ((drumGrid && drumGrid.length > 0 && drumGrid[0]) ? drumGrid[0].length : 64);

    const hasMelody = Array.isArray(melodyGrid) && melodyGrid.length > 0 && Array.isArray(scaleFreqs) && scaleFreqs.length > 0;
    const hasDrum = Array.isArray(drumGrid) && drumGrid.length > 0;

    if ((!hasMelody && !hasDrum) || totalSteps === 0) {
      return this.ctx.createBuffer(2, Math.floor(sampleRate * 0.1), sampleRate);
    }

    // ★ Rust (Wasm) が利用可能な場合は超高速演算
    if (this.wasmCore && this.wasmCore.render_song_maker_music) {
      try {
        // 2次元配列を1次元の Uint8Array にフラット化
        const melodyFlat = new Uint8Array(melodyGrid.length * totalSteps);
        for (let r = 0; r < melodyGrid.length; r++) {
          for (let c = 0; c < totalSteps; c++) {
            melodyFlat[r * totalSteps + c] = melodyGrid[r][c] ? 1 : 0;
          }
        }

        const drumFlat = new Uint8Array(2 * totalSteps);
        for (let d = 0; d < 2; d++) {
          for (let c = 0; c < totalSteps; c++) {
            drumFlat[d * totalSteps + c] = drumGrid[d][c] ? 1 : 0;
          }
        }

        const validScaleFreqs = new Float32Array(scaleFreqs);
        if (validScaleFreqs.length === 0 || totalSteps === 0) {
          return this.ctx.createBuffer(2, sampleRate * 1, sampleRate);
        }

        const rawPcm = this.wasmCore.render_song_maker_music(
          melodyFlat,
          drumFlat,
          validScaleFreqs,
          totalSteps,
          bpm,
          instrument,
          drumKit,
          sampleRate
        );

        if (!rawPcm || rawPcm.length === 0) {
          throw new Error("Wasm returned empty PCM");
        }

        const numFrames = Math.floor(rawPcm.length / 2);
        const buffer = this.ctx.createBuffer(2, numFrames, sampleRate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);

        for (let i = 0; i < numFrames; i++) {
          left[i] = rawPcm[i * 2];
          right[i] = rawPcm[i * 2 + 1];
        }

        return buffer;
      } catch (err) {
        console.warn("Wasm SongMaker レンダリング失敗のため JS にフォールバックします:", err);
      }
    }

    // JS フォールバック処理
    const secondsPerStep = (60 / bpm) / 4; // 16分音符
    const duration = totalSteps * secondsPerStep;
    const totalSamples = Math.floor(sampleRate * duration);

    const buffer = this.ctx.createBuffer(2, totalSamples, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    for (let step = 0; step < totalSteps; step++) {
      const stepStartTime = step * secondsPerStep;
      const startSample = Math.floor(stepStartTime * sampleRate);

      // メロディの発音合成 (ステレオパンニング・アタック改善)
      for (let row = 0; row < melodyGrid.length; row++) {
        if (melodyGrid[row] && melodyGrid[row][step]) {
          const freq = scaleFreqs[row];
          const toneSamples = Math.max(0, Math.min(totalSamples - startSample, Math.floor(sampleRate * 0.45)));
          const pan = melodyGrid.length > 1 
            ? ((row / (melodyGrid.length - 1)) - 0.5) * 0.4 
            : 0;

          for (let s = 0; s < toneSamples; s++) {
            const outIdx = startSample + s;
            if (outIdx >= totalSamples) break; // バッファ終端ガード

            const t = s / sampleRate;
            let wave = 0;
            if (instrument === 'marimba') {
              wave = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 11) * 0.45;
            } else if (instrument === 'synth') {
              const saw = 2 * ((t * freq) % 1) - 1;
              const sub = Math.sin(2 * Math.PI * (freq / 2) * t) * 0.25;
              wave = (saw * 0.7 + sub) * Math.exp(-t * 5) * 0.35;
            } else if (instrument === 'piano') {
              wave = (Math.sin(2 * Math.PI * freq * t) + Math.sin(2 * Math.PI * freq * 2 * t) * 0.35 + Math.sin(2 * Math.PI * freq * 3 * t) * 0.15) * Math.exp(-t * 4.5) * 0.40;
            } else { // chiptune
              wave = (Math.sin(2 * Math.PI * freq * t) > 0 ? 0.25 : -0.25) * Math.exp(-t * 8);
            }
            left[outIdx] += wave * (0.5 - pan);
            right[outIdx] += wave * (0.5 + pan);
          }
        }
      }

      // ドラムの発音合成 (row 0: スネア, row 1: キック)
      if (drumGrid[0] && drumGrid[0][step] && startSample < totalSamples) { // スネア
        const snareSamples = Math.max(0, Math.min(totalSamples - startSample, Math.floor(sampleRate * 0.15)));
        for (let s = 0; s < snareSamples; s++) {
          const outIdx = startSample + s;
          if (outIdx >= totalSamples) break;
          const t = s / sampleRate;
          const noise = (Math.random() * 2 - 1) * Math.exp(-t * 24) * 0.28;
          left[outIdx] += noise;
          right[outIdx] += noise;
        }
      }

      if (drumGrid[1] && drumGrid[1][step] && startSample < totalSamples) { // キック
        const kickSamples = Math.max(0, Math.min(totalSamples - startSample, Math.floor(sampleRate * 0.22)));
        for (let s = 0; s < kickSamples; s++) {
          const outIdx = startSample + s;
          if (outIdx >= totalSamples) break; // バッファ終端ガード

          const t = s / sampleRate;
          // 瞬時周波数の積分により正確な位相を算出（ピッチスイープの破綻防止）
          const kickPhase = 2 * Math.PI * ((120 * (1 - Math.exp(-t * 26)) / 26) + 35 * t);
          const kickWave = Math.sin(kickPhase) * Math.exp(-t * 14) * 0.5;
          left[outIdx] += kickWave;
          right[outIdx] += kickWave;
        }
      }
    }

    // クリッピング防止リミッター
    for (let i = 0; i < totalSamples; i++) {
      left[i] = Math.max(-0.95, Math.min(0.95, left[i]));
      right[i] = Math.max(-0.95, Math.min(0.95, right[i]));
    }

    return buffer;
  }

  // ★ 音声ファイルから波形Canvasを非同期生成（Wasm/JSピーク抽出対応）
  async generateWaveformCanvas(file, volumeMultiplier = 1.0, width = 800, height = 60) {
    let blobUrl = null;
    let rawArrayBuffer = null;
    try {
      blobUrl = URL.createObjectURL(file);
      const res = await fetch(blobUrl);
      rawArrayBuffer = await res.arrayBuffer();

      if (!this.ctx) return null;
      // デコード用バッファを生成後、大元の生バッファ参照を即時破棄
      const copyBuffer = rawArrayBuffer.slice(0);
      rawArrayBuffer = null;

      const audioBuffer = await this.ctx.decodeAudioData(copyBuffer).catch(() => null);
      if (!audioBuffer) {
        return null; // 音声トラックのない動画は波形なしで正常終了
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      const rawData = audioBuffer.getChannelData(0);
      const samples = width;
      const centerY = height / 2;

      ctx.strokeStyle = 'rgba(0, 240, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(width, centerY);
      ctx.stroke();

      let peaks = null;
      if (this.wasmCore && this.wasmCore.extract_waveform_peaks) {
        try {
          peaks = this.wasmCore.extract_waveform_peaks(rawData, samples);
        } catch (wasmErr) {
          peaks = null;
        }
      }

      if (!peaks) {
        peaks = new Float32Array(samples * 2);
        const totalLen = rawData.length;
        for (let i = 0; i < samples; i++) {
          let min = 1.0, max = -1.0;
          const start = Math.floor((i * totalLen) / samples);
          const end = Math.min(totalLen, Math.floor(((i + 1) * totalLen) / samples));
          for (let j = start; j < end; j++) {
            const val = rawData[j];
            if (val < min) min = val;
            if (val > max) max = val;
          }
          if (min > max) {
            peaks[i * 2] = 0;
            peaks[i * 2 + 1] = 0;
          } else {
            peaks[i * 2] = min;
            peaks[i * 2 + 1] = max;
          }
        }
      }

      ctx.fillStyle = '#00f0ff';
      ctx.beginPath();
      const halfH = centerY * 0.95;
      const gain = Math.max(0.1, Math.min(3.0, volumeMultiplier));

      for (let i = 0; i < samples; i++) {
        const min = peaks[i * 2] * gain;
        const max = peaks[i * 2 + 1] * gain;
        const top = centerY + Math.max(-centerY, Math.min(centerY, min * halfH));
        const bottom = centerY + Math.max(-centerY, Math.min(centerY, max * halfH));
        ctx.rect(i, top, 1, Math.max(1, bottom - top));
      }
      ctx.fill();

      return {
        canvas: canvas,
        originalFile: file,
        duration: audioBuffer.duration
      };
    } catch (e) {
      // 音声なしファイルによる想定内のデコード失敗時はログを抑制
      return null;
    } finally {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
    }
  }

  // ★ 4. Song Maker 音階スケール周波数テーブルの生成
  getScaleFrequencies(scaleMode = 'major', octaveMode = 'mid') {
    const baseFreqs = {
      major: [698.46, 659.25, 587.33, 523.25, 493.88, 440.00, 392.00, 349.23, 329.63, 293.66, 261.63], // F5〜C4
      minor: [659.25, 587.33, 523.25, 493.88, 440.00, 392.00, 349.23, 329.63, 293.66, 261.63, 220.00], // E5〜A3
      penta: [783.99, 659.25, 587.33, 523.25, 440.00, 392.00, 329.63, 293.66, 261.63, 220.00, 196.00]  // G5〜G3
    };
    const freqs = baseFreqs[scaleMode] || baseFreqs.major;
    const mult = octaveMode === 'high' ? 2.0 : (octaveMode === 'low' ? 0.5 : 1.0);
    return freqs.map(f => f * mult);
  }

  // ★ 5. フレーズの目標ステップ数への自動ループ拡張
  expandPatternGrid(grid, targetSteps, melodyRows) {
    const baseSteps = grid[0] ? grid[0].length : targetSteps;
    if (targetSteps <= baseSteps) return grid;

    return Array.from({ length: melodyRows }, (_, r) => {
      const row = [];
      for (let c = 0; c < targetSteps; c++) {
        row.push(grid[r] ? !!grid[r][c % baseSteps] : false);
      }
      return row;
    });
  }
}

window.AudioSynthEngine = AudioSynthEngine;