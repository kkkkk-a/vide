/**
 * ProjectManager - プロジェクト保存 & 読み込み (最適化・厳格バリデーション版)
 */
class ProjectManager {
  constructor() {}

  /**
   * 現在のプロジェクトを軽量化して JSON ファイルとして保存
   * @param {Object} editor - VideoEditorEngine インスタンス
   * @param {string} projectName - プロジェクトファイル名
   */
  static saveProject(editor, projectName = 'my-project') {
    if (!editor || !editor.state) {
      alert("保存するプロジェクトデータがありません。");
      return;
    }

    const state = editor.state;

    // トラック素材のサニタイズとシリアライズ
    const serializableTracks = state.tracks.map(t => {
      const {
        element, model, mixer, waveform,
        _audioSourceNode, _audioNodes, _mediaGainNode, _mediaElementSourceNode,
        innerMediaElement, _cachedLines, _cachedTransform, _animResultBuffer,
        _kfResultBuffer, _finalTransformBuffer, _cachedBitmapKey, _cachedCanvas,
        ...safeProps
      } = t;

      const trackData = JSON.parse(JSON.stringify(safeProps));

      // 画像素材でDataURIの場合は保持
      if (t.type === 'image' && t.element && t.element.src && t.element.src.startsWith('data:')) {
        trackData.dataUri = t.element.src;
      }

      return trackData;
    });

    const projectData = {
      app: "ProVideoEditor",
      version: "1.1.0",
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

    const jsonString = JSON.stringify(projectData, null, 2);
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
  }

  /**
   * JSON ファイルを厳格バリデーションしてプロジェクトを完全復元
   * @param {Object} editor - VideoEditorEngine インスタンス
   * @param {File} file - 読み込む .json ファイル
   */
  static async loadProject(editor, file) {
    if (!file || !editor) return;

    try {
      editor.showLoading("プロジェクトファイルを検証中...");
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

      // 1. 設定の復元とサニタイズ
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
        const lutSelect = document.getElementById('filter-lut-preset');
        if (lutSelect) lutSelect.value = settings.filters.lutPreset || 'none';
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

      // 既存リソースの破棄
      editor.state.tracks.forEach(t => editor.disposeClip(t));
      editor.state.tracks = [];

      editor.showLoading("素材リソースを構築中...");

      // 2. トラック素材の非同期並行復元
      const restoredClips = [];

      for (let i = 0; i < project.tracks.length; i++) {
        const t = project.tracks[i];
        if (!t || typeof t !== 'object') continue;

        let restoredElement = null;
        let restoredModel = null;
        let restoredWaveform = null;

        // 3Dオブジェクトの再構築
        if (t.type === '3d' && editor.threeEngine) {
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

        // BGM (Song Maker) の再構築
        if (t.type === 'audio' && t.songMakerData && editor.synthEngine) {
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

        // 画像・ストック素材の再構築
        if (t.type === 'image' && t.dataUri) {
          const img = new Image();
          img.src = t.dataUri;
          restoredElement = img;
        }

        const validClip = {
          ...t,
          id: t.id || `clip-${Date.now()}-${i}`,
          startTime: typeof t.startTime === 'number' ? Math.max(0, t.startTime) : 0,
          duration: typeof t.duration === 'number' ? Math.max(0.1, t.duration) : 3,
          trackIndex: typeof t.trackIndex === 'number' ? Math.max(0, t.trackIndex) : 0,
          transform: t.transform || { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 },
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