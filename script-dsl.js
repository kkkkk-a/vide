/**
 * ScriptDSL - 台本テキストとタイムラインデータの双方向変換エンジン
 */
class ScriptDSL {
  // ★ DSL識別子 / Quillクラス名 / 実フォント名（Canvas）の一元マスタ
  static FONTS = [
    { dsl: 'rounded', quill: 'm-plus-rounded', family: 'M PLUS Rounded 1c' },
    { dsl: 'dot',     quill: 'dot-gothic',     family: 'DotGothic16' },
    { dsl: 'klee',    quill: 'klee-one',       family: 'Klee One' },
    { dsl: 'mincho',  quill: 'shippori-mincho', family: 'Shippori Mincho' },
    { dsl: 'sans',    quill: 'sans-serif',     family: 'sans-serif' }
  ];

  static getFamilyFromDsl(dslName) {
    const entry = ScriptDSL.FONTS.find(f => f.dsl === dslName || f.quill === dslName || f.family === dslName);
    return entry ? entry.family : 'M PLUS Rounded 1c';
  }

  static getDslFromFamily(family) {
    const entry = ScriptDSL.FONTS.find(f => f.family === family || f.quill === family || f.dsl === family);
    return entry ? entry.dsl : 'rounded';
  }

  static getQuillFromFamily(family) {
    const entry = ScriptDSL.FONTS.find(f => f.family === family || f.dsl === family || f.quill === family);
    return entry ? entry.quill : 'sans-serif';
  }

  static getFamilyFromQuill(quillName) {
    const entry = ScriptDSL.FONTS.find(f => f.quill === quillName || f.dsl === quillName || f.family === quillName);
    return entry ? entry.family : 'sans-serif';
  }

  // ★ 宣言的 DSL オプション変換スキーマ（新属性追加はここに追加するだけで自動連動）
  static DSL_OPTIONS_SCHEMA = [
    { key: 'x', getter: c => c.transform?.x, setter: (c, v) => { if (!c.transform) c.transform = {}; c.transform.x = parseFloat(v); } },
    { key: 'y', getter: c => c.transform?.y, setter: (c, v) => { if (!c.transform) c.transform = {}; c.transform.y = parseFloat(v); } },
    { key: 'scale', getter: c => (c.transform?.scale !== 1 ? c.transform?.scale : undefined), setter: (c, v) => { if (!c.transform) c.transform = {}; c.transform.scale = parseFloat(v); } },
    { key: 'rot', getter: c => c.transform?.rotation, setter: (c, v) => { if (!c.transform) c.transform = {}; c.transform.rotation = parseFloat(v); } },
    { key: 'color', getter: c => c.color, setter: (c, v) => { c.color = v; } },
    { key: 'size', getter: c => c.fontSize || c.size, setter: (c, v) => { c.fontSize = parseInt(v); c.size = parseInt(v); } },
    { key: 'stroke', getter: c => (c.strokeEnabled ? c.strokeWidth : undefined), setter: (c, v) => { c.strokeEnabled = true; c.strokeWidth = parseFloat(v); } },
    { key: 'scolor', getter: c => (c.strokeColor !== '#000000' ? c.strokeColor : undefined), setter: (c, v) => { c.strokeColor = v; } },
    { key: 'stroke2', getter: c => (c.stroke2Enabled ? c.stroke2Width : undefined), setter: (c, v) => { c.stroke2Enabled = true; c.stroke2Width = parseFloat(v); } },
    { key: 'scolor2', getter: c => (c.stroke2Enabled ? c.stroke2Color : undefined), setter: (c, v) => { c.stroke2Color = v; } },
    { key: 'tgrad', getter: c => (c.gradientEnabled ? 'true' : undefined), setter: (c, v) => { c.gradientEnabled = (v === 'true' || v === true); } },
    { key: 'tg1', getter: c => (c.gradientEnabled ? c.gradientColor1 : undefined), setter: (c, v) => { c.gradientColor1 = v; } },
    { key: 'tg2', getter: c => (c.gradientEnabled ? c.gradientColor2 : undefined), setter: (c, v) => { c.gradientColor2 = v; } },
    { key: 'glow', getter: c => (c.glowEnabled ? c.glowBlur : undefined), setter: (c, v) => { c.glowEnabled = true; c.glowBlur = parseFloat(v); } },
    { key: 'gcolor', getter: c => (c.glowEnabled ? c.glowColor : undefined), setter: (c, v) => { c.glowColor = v; } },
    { key: 'mask', getter: c => (c.maskType !== 'none' ? c.maskType : undefined), setter: (c, v) => { c.maskType = v; } },
    { key: 'blend', getter: c => (c.blendMode !== 'source-over' ? c.blendMode : undefined), setter: (c, v) => { c.blendMode = v; } },
    { key: 'speed', getter: c => (c.playbackSpeed !== 1.0 ? c.playbackSpeed : undefined), setter: (c, v) => { c.playbackSpeed = parseFloat(v); } },
    { key: 'offset', getter: c => (c.mediaOffset > 0 ? c.mediaOffset.toFixed(2) : undefined), setter: (c, v) => { c.mediaOffset = parseFloat(v); } },
    { key: 'in', getter: c => (c.animProps?.inAnim !== 'none' ? c.animProps?.inAnim : undefined), setter: (c, v) => { if (!c.animProps) c.animProps = {}; c.animProps.inAnim = v; } },
    { key: 'main', getter: c => (c.animProps?.mainAnim !== 'none' ? c.animProps?.mainAnim : undefined), setter: (c, v) => { if (!c.animProps) c.animProps = {}; c.animProps.mainAnim = v; } },
    { key: 'out', getter: c => (c.animProps?.outAnim !== 'none' ? c.animProps?.outAnim : undefined), setter: (c, v) => { if (!c.animProps) c.animProps = {}; c.animProps.outAnim = v; } }
  ];

  // タイムラインデータを台本DSL文字列に変換（スキーマ駆動自動出力）
  static exportToScript(tracks, markers = []) {
    const sorted = [...tracks].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    const markerLines = markers.map(m => `${m.time.toFixed(2)} | marker | ${m.label}`);

    const clipLines = sorted.map(clip => {
      const start = (clip.startTime || 0).toFixed(2);
      const end = (clip.startTime + clip.duration).toFixed(2);
      const type = clip.type;

      let content = clip.text || clip.name || type;
      if (type === 'text' && Array.isArray(clip.textKeyframes) && clip.textKeyframes.length > 0) {
        content = clip.textKeyframes.map(k => `[${k.time}s] ${k.text.replace(/\n/g, '\\n')}`).join(' ');
      }

      const opts = [];
      if (clip.trackIndex !== undefined) opts.push(`track:${clip.trackIndex + 1}`);
      if (clip.fontFamily) opts.push(`font:${ScriptDSL.getDslFromFamily(clip.fontFamily)}`);

      // スキーマに基づき登録済みプロパティを自動出力
      this.DSL_OPTIONS_SCHEMA.forEach(({ key, getter }) => {
        const val = getter(clip);
        if (val !== undefined && val !== null && val !== '') {
          opts.push(`${key}:${val}`);
        }
      });

      const optStr = opts.length > 0 ? ` | ${opts.join(', ')}` : '';
      return `${start} - ${end} | ${type} | ${content}${optStr}`;
    });

    return [...markerLines, ...clipLines].join('\n');
  }

  // 実践テンプレート台本プリセット集（二重フチ・光彩・文字単位アニメ完全対応版）
  static tutorials = {
    preset1: [
      "// --- 1. ショート動画 / TikTok テロップ構成 (極太二重フチ & 文字単位ポップ) ---",
      "0.00 - 4.50 | text | [重大発表]\\nついに新機能が解禁！ | track:1, color:#ffffff, size:52, font:rounded, stroke:6, scolor:#000000, stroke2:14, scolor2:#ff2d55, in:charPop, inDur:1.2, y:-120",
      "0.00 - 4.00 | sticker | svg-fire | track:2, color:#ff9500, scale:0.9, x:160, y:-120, main:heartbeat",
      "1.20 - 5.50 | text | 驚きのクオリティを体感せよ | track:3, color:#ffffff, size:44, font:mincho, stroke:5, scolor:#000000, stroke2:12, scolor2:#00f0ff, in:charDrop, inDur:1.0, y:60",
      "3.50 - 7.00 | text | 今すぐチェック！ | track:4, color:#ffff00, size:50, font:dot, stroke:8, scolor:#000000, in:charBounce, out:popOut, y:180",
      "3.50 - 7.00 | sticker | svg-subscribe | track:4, color:#ff0000, in:slideUp, y:260"
    ].join('\n'),
    preset2: [
      "// --- 2. ネオンサイバー & グリッチ アニメーション構成 (外側光彩) ---",
      "0.50 - 6.00 | rounded-rect | 背景フレーム | track:1, color:#9333ea, grad:linear, g1:#9333ea, g2:#00f0ff, size:280, scale:1.1, main:heartbeat, y:0",
      "0.00 - 4.50 | text | CYBER GLITCH | track:2, color:#ffffff, size:56, font:dot, stroke:4, scolor:#09090b, glow:20, gcolor:#00f0ff, in:charDrop, main:glitch, y:-140",
      "2.00 - 6.50 | text | 衝撃のラストを見逃すな | track:3, color:#ffffff, size:46, stroke:6, scolor:#000000, stroke2:14, scolor2:#ffb703, in:charPop, out:shrinkSpin, y:140"
    ].join('\n'),
    preset3: [
      "// --- 3. パーティクル＆ネオン演出構成 ---",
      "0.00 - 7.00 | 3d | particles-fire | track:1, color:#ff4500, scale:1.2, speed:1.4",
      "0.00 - 7.00 | 3d | star | track:2, color:#ffff00, scale:0.7, rotX:20, animMode:spin, metal:80, rough:20, y:-30",
      "0.50 - 5.50 | text | FIRE PARTICLES & 3D STAR | track:3, color:#ffffff, size:46, font:rounded, in:popUp, y:180"
    ].join('\n'),
    preset4: [
      "// --- 4. BGM＆効果音同期オープニング ---",
      "0.00 - 8.00 | bgm | synthwave | track:1, bpm:124, vol:80, fadeIn:0.5, fadeOut:1.5",
      "0.00 - 0.50 | se | whoosh | track:2, vol:90",
      "3.50 - 4.00 | se | coin | track:2, vol:100",
      "0.00 - 3.80 | text | CYBERPUNK 2025 | track:3, color:#00f0ff, size:54, font:dot, in:popUp, main:glitch, y:-60",
      "3.80 - 8.00 | text | MISSION COMPLETE | track:4, color:#ffff00, size:50, font:rounded, in:bounceIn, y:60"
    ].join('\n'),
    preset_rta: [
      "// --- 5. biimシステム風 (解説枠 構成) ---",
      "0.00 - 10.00 | text | [0s] ここでジャンプと攻撃を同フレームに入力します。 [3.5s] 成功！約1.5秒のタイム短縮です。 [7.0s] 次の難所に向けてチャートを確認していきます。 | track:1, color:#ffffff, size:28, font:dot, x:145, y:-395",
      "0.00 - 10.00 | text | -- TIME --\\n01:23.45 | track:2, color:#ffff00, size:26, font:dot, x:725, y:420",
      "0.00 - 10.00 | text | -- 進行チャート --\\n[区間] ステージ1\\n[目標] 02:45 切り\\n\\n・第1ボス撃破\\n・壁抜け成功\\n・次マップへ直行 | track:2, color:#00f0ff, size:22, font:dot, x:725, y:22",
      "0.00 - 10.00 | text | 立ち絵\\n(キャラ) | track:3, color:#a1a1aa, size:22, font:dot, x:-800, y:-395",
      "0.00 - 10.00 | text | [ ゲームプレイ画面 (4:3 / 16:9) ] | track:3, color:#71717a, size:28, font:dot, x:-225, y:125",
      "0.00 - 10.00 | rect | メインゲーム枠 | track:4, color:#141417, w:1420, h:780, border:3, bcolor:#ffffff, x:-225, y:125",
      "0.00 - 10.00 | rect | 右上タイマー枠 | track:5, color:#18181b, w:430, h:190, border:3, bcolor:#ffffff, x:725, y:420",
      "0.00 - 10.00 | rect | 右側チャート枠 | track:6, color:#18181b, w:430, h:565, border:3, bcolor:#ffffff, x:725, y:22",
      "0.00 - 10.00 | rect | 左下立ち絵枠   | track:7, color:#18181b, w:270, h:230, border:3, bcolor:#ffffff, x:-800, y:-395",
      "0.00 - 10.00 | rect | 下部解説字幕枠 | track:8, color:#141417, w:1580, h:230, border:3, bcolor:#ffffff, x:145, y:-395",
      "0.00 - 10.00 | bgm | chiptune | track:9, bpm:136, vol:50, fadeIn:0.3, fadeOut:1.0",
      "0.00 - 0.50 | se | click | track:9, vol:80",
      "3.50 - 4.00 | se | coin | track:9, vol:100",
      "7.00 - 7.50 | se | powerup | track:9, vol:90"
    ].join('\n')
  };

  // 台本テキストから完全なクリップオブジェクト配列を安全に生成（スマートトラック自動配置）
  static buildTracksFromScript(scriptText, existingClips = [], threeEngine = null, synthEngine = null) {
    const rawLines = scriptText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    
    // 既存の動画・音声・背景クリップを保持
    const preservedMedia = existingClips.filter(c =>
      c.type === 'video' || c.type === 'background' ||
      (c.type === 'audio' && !c.id.startsWith('bgm-') && !c.id.startsWith('se-') && !c.id.startsWith('audio-script-'))
    );
    const newTracks = [...preservedMedia];
    const newMarkers = [];
    let errorCount = 0;

    // 既存メディアが使用しているトラック番号の最大値を算出（衝突防止オフセット）
    const usedTrackIndices = preservedMedia.map(c => c.trackIndex || 0);
    const baseTrackOffset = usedTrackIndices.length > 0 ? Math.max(...usedTrackIndices) + 1 : 0;

    rawLines.forEach((line, idx) => {
      const lineMatch = line.match(/^([\d\.\s\-]+)\|\s*([a-zA-Z0-9_\-]+)\s*\|\s*([\s\S]*)$/);
      if (!lineMatch) {
        errorCount++;
        return;
      }

      const timeParts = lineMatch[1].split('-').map(t => parseFloat(t.trim()));
      const startT = !isNaN(timeParts[0]) ? timeParts[0] : 0;
      const endT = !isNaN(timeParts[1]) ? timeParts[1] : startT + 3.0;
      const duration = Math.max(0.1, parseFloat((endT - startT).toFixed(2)));
      const type = lineMatch[2].trim().toLowerCase();
      let remaining = lineMatch[3].trim();

      if (type === 'marker') {
        newMarkers.push({ time: startT, label: remaining || '編集ポイント', id: `m-${Date.now()}-${idx}` });
        return;
      }

      let content = remaining;
      const opts = {};
      const lastPipeIdx = remaining.lastIndexOf('|');

      if (lastPipeIdx !== -1) {
        const potentialOpt = remaining.slice(lastPipeIdx + 1).trim();
        if (potentialOpt.includes(':')) {
          content = remaining.slice(0, lastPipeIdx).trim();
          const pairs = potentialOpt.split(',');
          for (let p = 0; p < pairs.length; p++) {
            const sepIdx = pairs[p].indexOf(':');
            if (sepIdx !== -1) {
              const k = pairs[p].slice(0, sepIdx).trim();
              const v = pairs[p].slice(sepIdx + 1).trim();
              if (k && v) opts[k] = v;
            }
          }
        }
      }
      content = content.replace(/\\n/g, '\n');

      // 既存トラックとの衝突を避けるスマートトラック番号の決定
      const specifiedTrack = opts.track ? Math.max(0, parseInt(opts.track) - 1) : 0;
      const targetTrackIdx = (baseTrackOffset > 0 && specifiedTrack < baseTrackOffset)
        ? specifiedTrack + baseTrackOffset
        : specifiedTrack;

      let clipModel = null;
      let clipElement = null;

      if (type === '3d' && threeEngine) {
        if (content.startsWith('particles') || content.startsWith('particle')) {
          const rawType = content.replace(/^particles?-?/, '').toLowerCase();
          const validTypes = ['fire', 'snow', 'rain', 'magic', 'bubbles', 'sparks', 'smoke', 'confetti', 'stars'];
          const pType = validTypes.find(t => rawType.includes(t)) || 'fire';
          clipModel = threeEngine.createParticleSystem(pType, opts.count ? parseInt(opts.count) : 250);
        } else {
          clipModel = threeEngine.createPrimitive(content, opts.color || '#00f0ff');
        }
      }

      if ((type === 'bgm' || type === 'music') && synthEngine) {
        const genre = opts.genre || content.toLowerCase() || 'lofi';
        const bpm = opts.bpm ? parseFloat(opts.bpm) : (genre === 'lofi' ? 85 : 120);
        const bars = Math.max(2, Math.ceil(duration / ((60 / bpm) * 4)));
        const buf = synthEngine.generateBGM(genre, bars, bpm);
        const blob = synthEngine.audioBufferToWavBlob(buf);
        clipElement = new Audio(URL.createObjectURL(blob));
        clipElement.preload = 'auto';
      } else if (type === 'se' && synthEngine) {
        const buf = synthEngine.generateSoundEffect(content.toLowerCase() || opts.type || 'coin');
        clipElement = new Audio(URL.createObjectURL(synthEngine.audioBufferToWavBlob(buf)));
        clipElement.preload = 'auto';
      } else if ((type === 'sticker' || type === 'svg') && window.StockLibrary) {
        const { img } = window.StockLibrary.createSvgImage(content, opts.color || '#00f0ff');
        clipElement = img;
      }

      const normType = (type === 'bgm' || type === 'se') ? 'audio' : (type === 'sticker' || type === 'svg' ? 'image' : type);

      const clip = {
        id: `${normType}-${Date.now()}-${idx}`,
        type: normType,
        startTime: startT,
        duration: duration,
        originalDuration: duration,
        mediaOffset: 0,
        playbackSpeed: 1.0,
        maskType: 'none',
        blendMode: 'source-over',
        trackIndex: targetTrackIdx,
        physics: {
          enabled: opts.collision !== 'false',
          isStatic: opts.static === 'true',
          bounciness: opts.bounce ? parseFloat(opts.bounce) / 100 : 0.4
        },
        audioFadeIn: opts.fadeIn ? parseFloat(opts.fadeIn) : 0,
        audioFadeOut: opts.fadeOut ? parseFloat(opts.fadeOut) : 0,
        element: clipElement,
        model: clipModel,
        materialProps: {
          color: opts.color || '#00f0ff',
          metalness: opts.metal !== undefined ? parseFloat(opts.metal) / 100 : 0.4,
          roughness: opts.rough !== undefined ? parseFloat(opts.rough) / 100 : 0.3,
          wireframe: false
        },
        transform: {
          x: 0,
          y: 0,
          scale: 1.0,
          rotation: 0,
          rotateX: opts.rotX !== undefined ? parseFloat(opts.rotX) : 0,
          rotateY: opts.rotY !== undefined ? parseFloat(opts.rotY) : 0,
          opacity: opts.opacity !== undefined ? Math.max(0, Math.min(1.0, parseFloat(opts.opacity))) : 1.0
        },
        animProps: {
          inAnim: 'none',
          mainAnim: 'none',
          outAnim: 'none',
          inDuration: opts.inDur ? parseFloat(opts.inDur) : 0.8,
          outDuration: opts.outDur ? parseFloat(opts.outDur) : 0.8
        }
      };

      // スキーマに基づき登録済みプロパティを一括自動代入
      this.DSL_OPTIONS_SCHEMA.forEach(({ key, setter }) => {
        if (opts[key] !== undefined) {
          setter(clip, opts[key]);
        }
      });

      const isDslShape = ['shape', 'rect', 'circle', 'rounded-rect', 'triangle', 'star', 'heart', 'diamond', 'hexagon', 'arrow', 'speech-bubble'].includes(type);

      if (type === 'text') {
        const kfRegex = /\[(\d+(?:\.\d+)?)s\]\s*([^\[]+)/g;
        kfRegex.lastIndex = 0;
        let match;
        const textKeyframes = [];
        while ((match = kfRegex.exec(content)) !== null) {
          textKeyframes.push({ time: parseFloat(match[1]), text: match[2].trim().replace(/\\n/g, '\n') });
        }
        clip.textKeyframes = textKeyframes.length > 0 ? textKeyframes : null;
        clip.text = textKeyframes.length > 0 ? textKeyframes[0].text : content;
        clip.fontFamily = opts.font ? ScriptDSL.getFamilyFromDsl(opts.font) : 'M PLUS Rounded 1c';
      } else if (isDslShape) {
        clip.type = type;
        clip.width = opts.w ? parseFloat(opts.w) : (clip.size || 200);
        clip.height = opts.h ? parseFloat(opts.h) : (clip.size || 200);
        clip.borderWidth = opts.border !== undefined ? parseFloat(opts.border) : 0;
        clip.borderColor = opts.bcolor || '#ffffff';
        clip.gradientType = opts.grad || 'solid';
        clip.gradientColor1 = opts.g1 || '#00f0ff';
        clip.gradientColor2 = opts.g2 || '#ff007f';
        clip.gradientAngle = opts.gAngle ? parseFloat(opts.gAngle) : 45;
        clip.name = content;
      } else {
        clip.name = content;
      }

      newTracks.push(clip);
    });

    return { newTracks, newMarkers, errorCount };
  }
}

window.ScriptDSL = ScriptDSL;