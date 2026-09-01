class ProjectManager {
  constructor() {}

  // Blob / File / URL を Base64 Data URL に変換するヘルパー
  static async blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // DataURL を Blob に変換するヘルパー
  static dataURLToBlob(dataURL) {
    const parts = dataURL.split(';base64,');
    const contentType = parts[0].split(':')[1];
    const raw = window.atob(parts[1]);
    const uInt8Array = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }
    return new Blob([uInt8Array], { type: contentType });
  }

  /**
   * 現在のプロジェクトを実体メディアごと JSON ファイルとして保存
   * @param {Object} editor - VideoEditorEngine インスタンス
   * @param {string} projectName - プロジェクトファイル名
   */
  static async saveProject(editor, projectName = 'my-project') {
    if (!editor || !editor.state) {
      alert("保存するプロジェクトデータがありません。");
      return;
    }

    editor.showLoading("プロジェクトと素材データを保存用に収集中...");

    try {
      const state = editor.state;
      const serializableTracks = [];

      for (let i = 0; i < state.tracks.length; i++) {
        const t = state.tracks[i];
        const {
          element, model, mixer, waveform,
          _audioSourceNode, _audioNodes, _mediaGainNode, _mediaElementSourceNode,
          innerMediaElement, _cachedLines, _cachedTransform, _animResultBuffer,
          _kfResultBuffer, _finalTransformBuffer, _cachedBitmapKey, _cachedCanvas,
          ...safeProps
        } = t;

        const trackData = JSON.parse(JSON.stringify(safeProps));

        // 動画・音声・画像の実体バイナリを DataURL として抽出・埋め込み
        if ((t.type === 'video' || t.type === 'audio' || t.type === 'image') && t.element && t.element.src) {
          try {
            if (t.element.src.startsWith('data:')) {
              trackData.mediaDataUri = t.element.src;
            } else {
              const res = await fetch(t.element.src);
              const blob = await res.blob();
              trackData.mediaDataUri = await ProjectManager.blobToDataURL(blob);
            }
          } catch (fetchErr) {
            console.warn("メディアのDataURL変換に失敗:", t.name, fetchErr);
          }
        }

        serializableTracks.push(trackData);
      }

      const projectData = {
        app: "ProVideoEditor",
        version: "2.0.0",
        savedAt: Date.now(),
        settings: {
          aspectRatio: state.aspectRatio || '9:16-hd',
          canvasWidth: editor.canvas.width,
          canvasHeight: editor.canvas.height,
          duration: Math.max(0.1, state.duration || 10),
          bgColor: state.bgColor || '#000000',
          volume: {
            video: state.volume?.video ?? 1.0,
            bgm: state.volume?.bgm ?? 1.0,
            pitch: state.volume?.pitch ?? 1.0
          },
          filters: { ...state.filters },
          chromaKey: { ...state.chromaKey }
        },
        trackStates: JSON.parse(JSON.stringify(state.trackStates || {})),
        markers: Array.isArray(state.markers) ? JSON.parse(JSON.stringify(state.markers)) : [],
        tracks: serializableTracks
      };

      const jsonString = JSON.stringify(projectData);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const filename = `${projectName.trim() || 'my-project'}.json`;

      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
      }, 3000);
    } catch (err) {
      alert("プロジェクト保存中にエラーが発生しました: " + err.message);
    } finally {
      editor.hideLoading();
    }
  }

  /**
   * JSON ファイルを解析して動画・音声・画像を完全復元
   * @param {Object} editor - VideoEditorEngine インスタンス
   * @param {File} file - 読み込む .json ファイル
   */
  static async loadProject(editor, file) {
    if (!file || !editor) return;

    try {
      editor.showLoading("プロジェクトファイルを検証・読み込み中...");
      const text = await file.text();
      let project = null;

      try {
        project = JSON.parse(text);
      } catch (parseErr) {
        throw new Error("JSONファイルの構文が不正です。");
      }

      if (!project || typeof project !== 'object' || !Array.isArray(project.tracks)) {
        throw new Error("有効なプロジェクトデータ構造が見つかりません。");
      }

      editor.pause();
      editor.saveState();

      const settings = project.settings || {};

      if (settings.aspectRatio) {
        editor.state.aspectRatio = settings.aspectRatio;
        const aspectSelect = document.getElementById('aspect-select');
        if (aspectSelect) aspectSelect.value = settings.aspectRatio;
      }

      editor.state.bgColor = settings.bgColor || '#000000';
      const bgPicker = document.getElementById('bg-color-picker');
      if (bgPicker) bgPicker.value = editor.state.bgColor;

      if (settings.volume) {
        editor.state.volume = {
          video: typeof settings.volume.video === 'number' ? settings.volume.video : 1.0,
          bgm: typeof settings.volume.bgm === 'number' ? settings.volume.bgm : 1.0,
          pitch: typeof settings.volume.pitch === 'number' ? settings.volume.pitch : 1.0
        };
        editor.updateVolume();
      }

      if (settings.filters) {
        editor.state.filters = { ...settings.filters };
        const bypassToggle = document.getElementById('filter-bypass-toggle');
        if (bypassToggle) bypassToggle.checked = editor.state.filters.enabled !== false;
        
        VideoEditorEngine.FILTER_SCHEMA.forEach(({ key }) => {
          const el = document.getElementById(`filter-${key}`);
          if (el && editor.state.filters[key] !== undefined) el.value = editor.state.filters[key];
        });

        const lutSelect = document.getElementById('filter-lut-preset');
        if (lutSelect) lutSelect.value = editor.state.filters.lutPreset || 'none';
      }

      if (settings.chromaKey) {
        editor.state.chromaKey = { ...settings.chromaKey };
        const chromaCheck = document.getElementById('chroma-enabled');
        if (chromaCheck) chromaCheck.checked = !!settings.chromaKey.enabled;
      }

      editor.updateAspectRatio();

      editor.state.trackStates = project.trackStates && typeof project.trackStates === 'object' ? JSON.parse(JSON.stringify(project.trackStates)) : {};
      editor.state.markers = Array.isArray(project.markers) ? JSON.parse(JSON.stringify(project.markers)) : [];
      editor.state.duration = Math.max(0.1, Number(settings.duration) || 10);

      editor.state.tracks.forEach(t => editor.disposeClip(t));
      editor.state.tracks = [];

      editor.showLoading("素材リソース（動画・音声・画像）を展開・構築中...");

      const restoredClips = [];

      for (let i = 0; i < project.tracks.length; i++) {
        const t = project.tracks[i];
        if (!t || typeof t !== 'object') continue;

        let restoredElement = null;
        let restoredModel = null;
        let restoredWaveform = null;

        // 1. 動画の復元
        if (t.type === 'video' && t.mediaDataUri) {
          const blob = ProjectManager.dataURLToBlob(t.mediaDataUri);
          const videoUrl = URL.createObjectURL(blob);
          const video = document.createElement('video');
          video.playsInline = true;
          video.style.display = 'none';
          video.src = videoUrl;
          video.preload = 'auto';
          document.body.appendChild(video);
          restoredElement = video;

          try {
            const fileObj = new File([blob], t.name || 'video.mp4', { type: blob.type });
            restoredWaveform = await editor.generateWaveformCanvas(fileObj, editor.state.volume?.video || 1.0);
          } catch (e) {}
        }
        // 2. 音声の復元
        else if (t.type === 'audio') {
          if (t.mediaDataUri) {
            const blob = ProjectManager.dataURLToBlob(t.mediaDataUri);
            const audioUrl = URL.createObjectURL(blob);
            const audio = new Audio(audioUrl);
            audio.preload = 'auto';
            restoredElement = audio;

            try {
              const fileObj = new File([blob], t.name || 'audio.wav', { type: blob.type });
              restoredWaveform = await editor.generateWaveformCanvas(fileObj, editor.state.volume?.bgm || 1.0);
            } catch (e) {}
          } else if (t.songMakerData && editor.synthEngine) {
            const sm = t.songMakerData;
            const freqs = editor.synthEngine.getScaleFrequencies('major', 'mid');
            const expandedMelody = editor.synthEngine.expandPatternGrid(sm.melodyGrid, sm.bars * 16, freqs.length);
            const expandedDrum = editor.synthEngine.expandPatternGrid(sm.drumGrid, sm.bars * 16, 2);
            const audioBuffer = editor.synthEngine.renderSongMakerBuffer(expandedMelody, expandedDrum, freqs, sm.bpm, sm.instrument, sm.drumKit);
            const wavBlob = editor.synthEngine.audioBufferToWavBlob(audioBuffer);
            const audioUrl = URL.createObjectURL(wavBlob);
            restoredElement = new Audio(audioUrl);
            restoredElement.preload = 'metadata';
            restoredWaveform = await editor.generateWaveformCanvas(new File([wavBlob], "bgm.wav", { type: "audio/wav" }), 1.0);
          }
        }
        // 3. 画像の復元
        else if (t.type === 'image') {
          const img = new Image();
          if (t.mediaDataUri) {
            img.src = t.mediaDataUri;
          } else if (t.dataUri) {
            img.src = t.dataUri;
          }
          restoredElement = img;
        }
        // 4. 3Dオブジェクトの復元
        else if (t.type === '3d' && editor.threeEngine) {
          const shapeType = t.name ? t.name.replace(/^3D\s*/, '').toLowerCase() : 'cube';
          if (shapeType.startsWith('particles')) {
            const pType = shapeType.replace(/^particles?-?/, '');
            restoredModel = editor.threeEngine.createParticleSystem(pType, 250);
          } else {
            restoredModel = editor.threeEngine.createPrimitive(shapeType, t.materialProps?.color || '#00f0ff');
          }
          if (t.materialProps) {
            editor.threeEngine.applyMaterialProps(restoredModel, t.materialProps);
          }
        }

        const validClip = {
          ...t,
          id: t.id || `clip-${Date.now()}-${i}`,
          startTime: typeof t.startTime === 'number' ? Math.max(0, t.startTime) : 0,
          duration: typeof t.duration === 'number' ? Math.max(0, t.duration) : 3,
          trackIndex: typeof t.trackIndex === 'number' ? Math.max(0, t.trackIndex) : 0,
          transform: {
            scale: 1.0,
            rotation: 0,
            rotateX: 0,
            rotateY: 0,
            x: 0,
            y: 0,
            opacity: 1.0,
            flipX: false,
            flipY: false,
            ...(t.transform || {})
          },
          crop: t.crop || { top: 0, bottom: 0, left: 0, right: 0 },
          filters: t.filters ? { ...t.filters } : undefined,
          voiceEffect: t.voiceEffect ? { ...t.voiceEffect } : undefined,
          element: restoredElement,
          model: restoredModel,
          waveform: restoredWaveform
        };

        if (editor._mediaRegistry) {
          editor._mediaRegistry.set(validClip.id, { element: restoredElement, model: restoredModel, waveform: restoredWaveform });
        }

        restoredClips.push(validClip);
      }

      editor.state.tracks = restoredClips;
      editor.selectedItems = [];
      editor.recalculateTotalDuration();
      editor.setupTimelineUI();
      editor.updateContextualToolbar();
      editor.seekTo(0, true);
      editor.requestRender();

      alert(`プロジェクト「${file.name}」を正常に読み込みました。`);
    } catch (err) {
      alert("プロジェクト読み込みエラー: " + err.message);
    } finally {
      editor.hideLoading();
    }
  }
}

window.ProjectManager = ProjectManager;
