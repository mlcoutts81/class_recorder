/* ClassRecorder — Universal Offline Classroom Voice Recorder
 * Strict Governance: 100% On-Device IndexedDB • Zero AI • Zero Cloud • Universal 16-bit PCM WAV
 */
(() => {
  'use strict';

  const DB_NAME = 'UniversalClassRecorderDB';
  const STORE_NAME = 'recordings';
  const IOS_TIP_STORAGE_KEY = 'classrecorder_ios_tip_dismissed';
  const MIN_TRIM_GAP = 0.1;

  // --- Application State ---
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let timerInterval = null;
  let recordStartMs = 0;
  let audioCtx = null;
  let analyserNode = null;
  let micSourceNode = null;
  let meterRafId = null;
  let playheadRafId = null;

  let activeRecord = null;
  let decodedBuffer = null;
  let previewSource = null;
  let previewStartCtxTime = 0;
  let previewOffsetSec = 0;
  let previewDurationSec = 0;
  let isPreviewPlaying = false;

  let draggingHandle = null; // 'start' | 'end' | null
  let activePointerId = null;
  let hoveredHandle = null;
  let deferredInstallPrompt = null;
  let pendingConfirmAction = null;
  let toastTimeout = null;

  // --- DOM References ---
  const installBtn = document.getElementById('installBtn');
  const iosTipToggleBtn = document.getElementById('iosTipToggleBtn');
  const iosInstallBanner = document.getElementById('iosInstallBanner');
  const dismissIosBannerBtn = document.getElementById('dismissIosBannerBtn');
  const offlineBadge = document.getElementById('offlineBadge');
  const offlineBadgeText = document.getElementById('offlineBadgeText');

  const micPickerWrap = document.getElementById('micPickerWrap');
  const micSelect = document.getElementById('micSelect');
  const singleMicStatus = document.getElementById('singleMicStatus');
  const singleMicLabel = document.getElementById('singleMicLabel');

  const recStatePill = document.getElementById('recStatePill');
  const recStateText = document.getElementById('recStateText');
  const timerEl = document.getElementById('timer');
  const levelMeterFill = document.getElementById('levelMeterFill');
  const recordBtn = document.getElementById('recordBtn');
  const stopBtn = document.getElementById('stopBtn');
  const mobileRecordBtn = document.getElementById('mobileRecordBtn');
  const mobileRecordLabel = document.getElementById('mobileRecordLabel');
  const mobilePlayBtn = document.getElementById('mobilePlayBtn');
  const mobilePlayLabel = document.getElementById('mobilePlayLabel');

  const recCountBadge = document.getElementById('recCountBadge');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const listEl = document.getElementById('recordingList');
  const storageUsageText = document.getElementById('storageUsageText');
  const storagePersistBadge = document.getElementById('storagePersistBadge');
  const storageBarFill = document.getElementById('storageBarFill');

  const emptyState = document.getElementById('emptyState');
  const editorPanel = document.getElementById('editorPanel');
  const clipTitle = document.getElementById('clipTitle');
  const clipDetailsText = document.getElementById('clipDetailsText');
  const selectionDurationText = document.getElementById('selectionDurationText');

  const playPauseBtn = document.getElementById('playPauseBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const playPauseLabel = document.getElementById('playPauseLabel');
  const audioPlayer = document.getElementById('audioPlayer');

  const canvas = document.getElementById('waveformCanvas');
  const resetTrimBtn = document.getElementById('resetTrimBtn');
  const trimStart = document.getElementById('trimStart');
  const trimEnd = document.getElementById('trimEnd');
  const startLabel = document.getElementById('startLabel');
  const endLabel = document.getElementById('endLabel');
  const nudgeStartMinus = document.getElementById('nudgeStartMinus');
  const nudgeStartPlus = document.getElementById('nudgeStartPlus');
  const nudgeEndMinus = document.getElementById('nudgeEndMinus');
  const nudgeEndPlus = document.getElementById('nudgeEndPlus');

  const previewTrimBtn = document.getElementById('previewTrimBtn');
  const previewTrimLabel = document.getElementById('previewTrimLabel');
  const applyTrimBtn = document.getElementById('applyTrimBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const statusToast = document.getElementById('statusToast');

  const confirmDialog = document.getElementById('confirmDialog');
  const confirmDialogTitle = document.getElementById('confirmDialogTitle');
  const confirmDialogMsg = document.getElementById('confirmDialogMsg');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const confirmAcceptBtn = document.getElementById('confirmAcceptBtn');

  // =========================================================================
  // 1. Service Worker, Offline Indicator & PWA Installation
  // =========================================================================
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
          // App remains functional even if SW is blocked (e.g. private browsing)
        });
      });
    }
  }

  function updateNetworkBadge() {
    const online = navigator.onLine !== false;
    if (online) {
      offlineBadge.classList.remove('is-offline');
      offlineBadgeText.textContent = 'Offline Ready';
    } else {
      offlineBadge.classList.add('is-offline');
      offlineBadgeText.textContent = 'Working Offline (Local Mode)';
    }
  }

  window.addEventListener('online', updateNetworkBadge);
  window.addEventListener('offline', updateNetworkBadge);

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installBtn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installBtn.hidden = true;
    showToast('ClassRecorder installed for offline use.');
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => {});
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  function isAppleTouchDeviceNotStandalone() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = Boolean(window.navigator.standalone) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    return isIOS && !isStandalone;
  }

  function initInstallTipBanner() {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(IOS_TIP_STORAGE_KEY) === '1';
    } catch (_) {}

    if (isAppleTouchDeviceNotStandalone() && !dismissed) {
      iosInstallBanner.hidden = false;
      iosTipToggleBtn.setAttribute('aria-expanded', 'true');
    }
  }

  iosTipToggleBtn.addEventListener('click', () => {
    const willShow = iosInstallBanner.hidden;
    iosInstallBanner.hidden = !willShow;
    iosTipToggleBtn.setAttribute('aria-expanded', String(willShow));
  });

  dismissIosBannerBtn.addEventListener('click', () => {
    iosInstallBanner.hidden = true;
    iosTipToggleBtn.setAttribute('aria-expanded', 'false');
    try {
      localStorage.setItem(IOS_TIP_STORAGE_KEY, '1');
    } catch (_) {}
  });

  // =========================================================================
  // 2. IndexedDB Storage & On-Device Quota Management
  // =========================================================================
  async function initPersistentStorage() {
    if (!navigator.storage) return;
    try {
      let persisted = false;
      if (navigator.storage.persisted) {
        persisted = await navigator.storage.persisted();
      }
      if (!persisted && navigator.storage.persist) {
        persisted = await navigator.storage.persist();
      }
      storagePersistBadge.textContent = persisted ? 'Protected Local DB' : 'Local DB';
    } catch (_) {
      storagePersistBadge.textContent = 'Local DB';
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function updateStorageEstimate(records = []) {
    const audioBytes = records.reduce((sum, rec) => sum + (rec.blob ? rec.blob.size : 0), 0);
    let usageBytes = audioBytes;
    let quotaBytes = 0;

    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        if (typeof estimate.usage === 'number' && estimate.usage > usageBytes) {
          usageBytes = estimate.usage;
        }
        if (typeof estimate.quota === 'number') {
          quotaBytes = estimate.quota;
        }
      } catch (_) {}
    }

    if (quotaBytes > 0) {
      const pct = Math.min(100, (usageBytes / quotaBytes) * 100);
      storageUsageText.textContent = `On-device storage: ${formatBytes(audioBytes)} audio (${formatBytes(usageBytes)} of ${formatBytes(quotaBytes)})`;
      storageBarFill.style.width = `${Math.max(audioBytes > 0 ? 1.5 : 0, pct).toFixed(2)}%`;
    } else {
      storageUsageText.textContent = `On-device storage: ${formatBytes(audioBytes)} used`;
      storageBarFill.style.width = audioBytes > 0 ? '4%' : '0%';
    }
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveRecordingDB(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function getAllRecordingsDB() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        db.close();
        const items = Array.isArray(req.result) ? req.result : [];
        resolve(items.sort((a, b) => b.createdAt - a.createdAt));
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function deleteRecordingDB(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function clearAllRecordingsDB() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  // =========================================================================
  // 3. Cross-Browser Audio Context, MIME Negotiation & Microphone Picker
  // =========================================================================
  function getAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function pickSupportedMimeType() {
    if (typeof window.MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4;codecs=mp4a.40.2'
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function loadMicrophones() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      micPickerWrap.hidden = true;
      singleMicStatus.hidden = false;
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const rawMics = devices.filter(d => d.kind === 'audioinput');
      // Filter out virtual 'default'/'communications' aliases when only 1 physical mic exists
      const nonAliasMics = rawMics.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
      const distinctMics = nonAliasMics.length > 0 ? nonAliasMics : rawMics;
      const previousValue = micSelect.value;

      if (distinctMics.length > 1) {
        micSelect.innerHTML = '';
        distinctMics.forEach((mic, index) => {
          const opt = document.createElement('option');
          opt.value = mic.deviceId;
          opt.textContent = mic.label || `Microphone ${index + 1}`;
          micSelect.appendChild(opt);
        });
        if (previousValue && Array.from(micSelect.options).some(o => o.value === previousValue)) {
          micSelect.value = previousValue;
        }
        micPickerWrap.hidden = false;
        singleMicStatus.hidden = true;
      } else {
        micSelect.innerHTML = '';
        micPickerWrap.hidden = true;
        singleMicStatus.hidden = false;
        const singleLabel = distinctMics[0] && distinctMics[0].label
          ? distinctMics[0].label
          : 'Default device microphone ready';
        singleMicLabel.textContent = singleLabel;
      }
    } catch (_) {
      micPickerWrap.hidden = true;
      singleMicStatus.hidden = false;
    }
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      loadMicrophones();
    });
  }

  // =========================================================================
  // 4. Audio Recording, Live Level Meter & Universal WAV Conversion
  // =========================================================================
  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const mins = String(Math.floor(total / 60)).padStart(2, '0');
    const secs = String(total % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function startLevelMeter(stream) {
    stopLevelMeter();
    try {
      const ctx = getAudioContext();
      micSourceNode = ctx.createMediaStreamSource(stream);
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      micSourceNode.connect(analyserNode);

      const timeData = new Uint8Array(analyserNode.fftSize);
      const tick = () => {
        if (!analyserNode) return;
        analyserNode.getByteTimeDomainData(timeData);
        let sumSq = 0;
        for (let i = 0; i < timeData.length; i++) {
          const norm = (timeData[i] - 128) / 128;
          sumSq += norm * norm;
        }
        const rms = Math.sqrt(sumSq / timeData.length);
        const pct = Math.min(100, Math.round(rms * 280));
        levelMeterFill.style.width = `${pct}%`;
        meterRafId = requestAnimationFrame(tick);
      };
      meterRafId = requestAnimationFrame(tick);
    } catch (_) {
      levelMeterFill.style.width = '0%';
    }
  }

  function stopLevelMeter() {
    if (meterRafId) {
      cancelAnimationFrame(meterRafId);
      meterRafId = null;
    }
    if (micSourceNode) {
      try { micSourceNode.disconnect(); } catch (_) {}
      micSourceNode = null;
    }
    analyserNode = null;
    levelMeterFill.style.width = '0%';
  }

  function setRecordingUIState(isRecording) {
    recordBtn.hidden = isRecording;
    stopBtn.hidden = !isRecording;
    recStatePill.classList.toggle('is-recording', isRecording);
    recStateText.textContent = isRecording ? 'Recording On-Device' : 'Ready to Record';

    if (isRecording) {
      mobileRecordBtn.className = 'btn-stop';
      mobileRecordLabel.textContent = 'Stop';
    } else {
      mobileRecordBtn.className = 'btn-record';
      mobileRecordLabel.textContent = 'Record';
    }
  }

  function makeSafeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function requestMicStream() {
    const selectedDeviceId = !micPickerWrap.hidden && micSelect.value ? micSelect.value : '';
    if (selectedDeviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: selectedDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true
          }
        });
      } catch (_) {
        // Fallback cleanly if a previously selected USB headset was unplugged
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  async function startRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') return;

    // Pause any active playback before recording
    stopPreviewPlayback();
    if (!audioPlayer.paused) audioPlayer.pause();

    try {
      getAudioContext();
      mediaStream = await requestMicStream();
      await loadMicrophones();

      const mimeType = pickSupportedMimeType();
      mediaRecorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream);
      chunks = [];

      mediaRecorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const usedType = (mediaRecorder && mediaRecorder.mimeType) || mimeType || 'audio/webm';
        const rawBlob = new Blob(chunks, { type: usedType });
        chunks = [];

        if (mediaStream) {
          mediaStream.getTracks().forEach(track => track.stop());
          mediaStream = null;
        }
        stopLevelMeter();

        if (rawBlob.size === 0) return;

        try {
          const ctx = getAudioContext();
          const rawArrayBuffer = await rawBlob.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(rawArrayBuffer.slice(0));
          const wavBlob = encodeTrimmedWav(audioBuffer, 0, audioBuffer.duration);

          const now = new Date();
          const timeStamp = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const newRec = {
            id: makeSafeId(),
            title: `Recording ${timeStamp}`,
            blob: wavBlob,
            mimeType: 'audio/wav',
            duration: audioBuffer.duration,
            sampleRate: audioBuffer.sampleRate,
            createdAt: Date.now()
          };

          await saveRecordingDB(newRec);
          await refreshList(newRec.id);
          showToast('Saved locally as universal .WAV');
        } catch (decodeErr) {
          console.error('Audio decode error:', decodeErr);
          showToast('Recording was too short to decode. Please record at least half a second.', true);
        }
      };

      mediaRecorder.start();
      startLevelMeter(mediaStream);

      recordStartMs = Date.now();
      timerEl.textContent = '00:00';
      clearInterval(timerInterval);
      timerInterval = setInterval(() => {
        const elapsedSec = (Date.now() - recordStartMs) / 1000;
        timerEl.textContent = formatClock(elapsedSec);
      }, 250);

      setRecordingUIState(true);
      stopBtn.focus();
    } catch (err) {
      console.error('Microphone access error:', err);
      showToast('Microphone permission denied or no microphone found. Check browser site permissions.', true);
    }
  }

  function stopRecording() {
    clearInterval(timerInterval);
    timerInterval = null;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    setRecordingUIState(false);
    recordBtn.focus();
  }

  function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  }

  recordBtn.addEventListener('click', startRecording);
  stopBtn.addEventListener('click', stopRecording);
  mobileRecordBtn.addEventListener('click', toggleRecording);

  // =========================================================================
  // 5. Playback Controls & Web Audio Trim Preview
  // =========================================================================
  function syncPlayButtonsUI() {
    const playing = (!audioPlayer.paused && !audioPlayer.ended) || isPreviewPlaying;
    playIcon.hidden = playing;
    pauseIcon.hidden = !playing;
    playPauseLabel.textContent = playing ? 'Pause' : 'Play';
    mobilePlayBtn.disabled = !activeRecord;
    mobilePlayLabel.textContent = playing ? 'Pause' : 'Play Clip';
    previewTrimLabel.textContent = isPreviewPlaying ? 'Stop Preview' : 'Preview Selection';

    if (playing && !playheadRafId) {
      const loop = () => {
        drawWaveform();
        if ((!audioPlayer.paused && !audioPlayer.ended) || isPreviewPlaying) {
          playheadRafId = requestAnimationFrame(loop);
        } else {
          playheadRafId = null;
          syncPlayButtonsUI();
          drawWaveform();
        }
      };
      playheadRafId = requestAnimationFrame(loop);
    }
  }

  function stopPreviewPlayback() {
    if (previewSource) {
      try {
        previewSource.onended = null;
        previewSource.stop();
      } catch (_) {}
      previewSource = null;
    }
    isPreviewPlaying = false;
    syncPlayButtonsUI();
    drawWaveform();
  }

  function toggleMainPlayback() {
    if (!activeRecord) return;
    if (isPreviewPlaying) {
      stopPreviewPlayback();
      return;
    }
    if (audioPlayer.paused) {
      audioPlayer.play().catch(() => {});
    } else {
      audioPlayer.pause();
    }
  }

  playPauseBtn.addEventListener('click', toggleMainPlayback);
  mobilePlayBtn.addEventListener('click', toggleMainPlayback);
  audioPlayer.addEventListener('play', () => {
    if (isPreviewPlaying) stopPreviewPlayback();
    syncPlayButtonsUI();
  });
  audioPlayer.addEventListener('pause', syncPlayButtonsUI);
  audioPlayer.addEventListener('ended', syncPlayButtonsUI);
  audioPlayer.addEventListener('timeupdate', drawWaveform);

  previewTrimBtn.addEventListener('click', () => {
    if (!decodedBuffer) return;
    if (isPreviewPlaying) {
      stopPreviewPlayback();
      return;
    }
    if (!audioPlayer.paused) audioPlayer.pause();

    const ctx = getAudioContext();
    const startSec = parseFloat(trimStart.value) || 0;
    const endSec = parseFloat(trimEnd.value) || decodedBuffer.duration;
    const durationSec = Math.max(MIN_TRIM_GAP, endSec - startSec);

    previewSource = ctx.createBufferSource();
    previewSource.buffer = decodedBuffer;
    previewSource.connect(ctx.destination);
    previewOffsetSec = startSec;
    previewDurationSec = durationSec;
    previewStartCtxTime = ctx.currentTime;
    isPreviewPlaying = true;

    previewSource.onended = () => {
      isPreviewPlaying = false;
      previewSource = null;
      syncPlayButtonsUI();
      drawWaveform();
    };

    previewSource.start(0, startSec, durationSec);
    syncPlayButtonsUI();
  });

  // =========================================================================
  // 6. Library Management & Clip Selection
  // =========================================================================
  async function refreshList(selectId = null) {
    const records = await getAllRecordingsDB();
    recCountBadge.textContent = String(records.length);
    clearAllBtn.hidden = records.length === 0;
    await updateStorageEstimate(records);

    listEl.innerHTML = '';

    if (records.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'rec-list-empty';
      emptyLi.textContent = 'No recordings saved on this device yet.';
      listEl.appendChild(emptyLi);

      activeRecord = null;
      decodedBuffer = null;
      editorPanel.hidden = true;
      emptyState.hidden = false;
      syncPlayButtonsUI();
      return;
    }

    if (selectId) {
      const target = records.find(r => r.id === selectId);
      if (target) {
        await loadRecordingIntoEditor(target);
      }
    } else if (activeRecord) {
      const refreshedActive = records.find(r => r.id === activeRecord.id);
      if (!refreshedActive) {
        activeRecord = null;
        decodedBuffer = null;
        editorPanel.hidden = true;
        emptyState.hidden = false;
      } else {
        activeRecord = refreshedActive;
      }
    }

    records.forEach(rec => {
      const li = document.createElement('li');
      const isSelected = Boolean(activeRecord && activeRecord.id === rec.id);
      li.className = 'rec-item' + (isSelected ? ' active' : '');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-current', isSelected ? 'true' : 'false');

      const mainWrap = document.createElement('span');
      mainWrap.className = 'rec-item-main';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'rec-item-title';
      titleSpan.textContent = rec.title;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'rec-item-meta';
      const durStr = typeof rec.duration === 'number' ? `${rec.duration.toFixed(1)}s` : '';
      const sizeStr = rec.blob ? formatBytes(rec.blob.size) : '';
      metaSpan.textContent = [durStr, sizeStr].filter(Boolean).join(' • ');

      mainWrap.appendChild(titleSpan);
      mainWrap.appendChild(metaSpan);

      const wavBadge = document.createElement('span');
      wavBadge.className = 'rec-item-wav';
      wavBadge.textContent = 'WAV';

      btn.appendChild(mainWrap);
      btn.appendChild(wavBadge);
      btn.addEventListener('click', async () => {
        await loadRecordingIntoEditor(rec);
        await refreshList();
      });

      li.appendChild(btn);
      listEl.appendChild(li);
    });

    syncPlayButtonsUI();
  }

  async function loadRecordingIntoEditor(rec) {
    stopPreviewPlayback();
    activeRecord = rec;
    emptyState.hidden = true;
    editorPanel.hidden = false;
    clipTitle.value = rec.title;

    if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioPlayer.src);
    }
    audioPlayer.src = URL.createObjectURL(rec.blob);

    const arrayBuffer = await rec.blob.arrayBuffer();
    decodedBuffer = await getAudioContext().decodeAudioData(arrayBuffer.slice(0));

    const exactDur = Math.max(MIN_TRIM_GAP, Number(decodedBuffer.duration.toFixed(1)));
    trimStart.min = '0';
    trimStart.max = String(exactDur);
    trimStart.step = '0.1';
    trimStart.value = '0';

    trimEnd.min = '0';
    trimEnd.max = String(exactDur);
    trimEnd.step = '0.1';
    trimEnd.value = String(exactDur);

    clipDetailsText.textContent = `${decodedBuffer.duration.toFixed(1)}s • ${(decodedBuffer.sampleRate / 1000).toFixed(1)} kHz • ${formatBytes(rec.blob.size)} WAV`;

    // Wait one frame if editorPanel was just unhidden so canvas layout rect is accurate
    requestAnimationFrame(() => {
      updateTrimUI('start');
    });
    updateTrimUI('start');
    syncPlayButtonsUI();
  }

  clipTitle.addEventListener('change', async () => {
    if (!activeRecord) return;
    activeRecord.title = clipTitle.value.trim() || 'Untitled Recording';
    clipTitle.value = activeRecord.title;
    await saveRecordingDB(activeRecord);
    await refreshList();
  });

  // =========================================================================
  // 7. Interactive Waveform Canvas (Unified Pointer Events) & Trim Sync
  // =========================================================================
  function getMaxDuration() {
    if (!decodedBuffer) return 10;
    return Math.max(MIN_TRIM_GAP, Number(decodedBuffer.duration.toFixed(1)));
  }

  function updateTrimUI(changed = 'start') {
    const maxDur = getMaxDuration();
    let s = parseFloat(trimStart.value);
    let e = parseFloat(trimEnd.value);

    if (!Number.isFinite(s)) s = 0;
    if (!Number.isFinite(e)) e = maxDur;

    s = Math.max(0, Math.min(maxDur - MIN_TRIM_GAP, s));
    e = Math.max(MIN_TRIM_GAP, Math.min(maxDur, e));

    if (s >= e - 0.001) {
      if (changed === 'start') {
        s = Math.max(0, Number((e - MIN_TRIM_GAP).toFixed(1)));
      } else {
        e = Math.min(maxDur, Number((s + MIN_TRIM_GAP).toFixed(1)));
      }
    }

    s = Number(s.toFixed(1));
    e = Number(e.toFixed(1));

    trimStart.value = s.toFixed(1);
    trimEnd.value = e.toFixed(1);
    startLabel.textContent = `${s.toFixed(1)}s`;
    endLabel.textContent = `${e.toFixed(1)}s`;

    const selLen = Math.max(0, e - s);
    selectionDurationText.textContent = `Selection: ${selLen.toFixed(1)}s (of ${maxDur.toFixed(1)}s)`;
    resetTrimBtn.hidden = (s === 0 && Math.abs(e - maxDur) < 0.05);

    nudgeStartMinus.disabled = s <= 0;
    nudgeStartPlus.disabled = s >= Number((e - MIN_TRIM_GAP).toFixed(1));
    nudgeEndMinus.disabled = e <= Number((s + MIN_TRIM_GAP).toFixed(1));
    nudgeEndPlus.disabled = e >= maxDur;

    drawWaveform();
  }

  function nudgeTrim(which, delta) {
    if (!decodedBuffer) return;
    if (which === 'start') {
      trimStart.value = (parseFloat(trimStart.value) + delta).toFixed(1);
      updateTrimUI('start');
    } else {
      trimEnd.value = (parseFloat(trimEnd.value) + delta).toFixed(1);
      updateTrimUI('end');
    }
  }

  trimStart.addEventListener('input', () => updateTrimUI('start'));
  trimEnd.addEventListener('input', () => updateTrimUI('end'));

  nudgeStartMinus.addEventListener('click', () => nudgeTrim('start', -0.1));
  nudgeStartPlus.addEventListener('click', () => nudgeTrim('start', 0.1));
  nudgeEndMinus.addEventListener('click', () => nudgeTrim('end', -0.1));
  nudgeEndPlus.addEventListener('click', () => nudgeTrim('end', 0.1));

  resetTrimBtn.addEventListener('click', () => {
    if (!decodedBuffer) return;
    trimStart.value = '0';
    trimEnd.value = String(getMaxDuration());
    updateTrimUI('start');
  });

  function drawRoundedRect(ctx2d, x, y, w, h, r) {
    ctx2d.beginPath();
    ctx2d.moveTo(x + r, y);
    ctx2d.lineTo(x + w - r, y);
    ctx2d.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx2d.lineTo(x + w, y + h - r);
    ctx2d.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx2d.lineTo(x + r, y + h);
    ctx2d.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx2d.lineTo(x, y + r);
    ctx2d.quadraticCurveTo(x, y, x + r, y);
    ctx2d.closePath();
  }

  function drawWaveform() {
    if (!decodedBuffer) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(240, Math.floor(rect.width * dpr));
    const height = Math.max(120, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx2d = canvas.getContext('2d');
    ctx2d.clearRect(0, 0, width, height);

    const maxDur = getMaxDuration();
    const startSec = parseFloat(trimStart.value) || 0;
    const endSec = parseFloat(trimEnd.value) || maxDur;
    const startX = Math.max(0, Math.min(width, (startSec / maxDur) * width));
    const endX = Math.max(0, Math.min(width, (endSec / maxDur) * width));

    // Active selection background highlight
    ctx2d.fillStyle = 'rgba(0, 94, 184, 0.22)';
    ctx2d.fillRect(startX, 0, Math.max(0, endX - startX), height);

    // Centre baseline
    ctx2d.fillStyle = 'rgba(148, 163, 184, 0.22)';
    ctx2d.fillRect(0, Math.floor(height / 2), width, Math.max(1, Math.floor(dpr)));

    // Waveform peak bars
    const channelData = decodedBuffer.getChannelData(0);
    const step = Math.max(1, Math.ceil(channelData.length / width));
    const midY = height / 2;
    const barGap = Math.max(1, Math.floor(2 * dpr));
    const barWidth = Math.max(1, Math.floor(1.5 * dpr));

    for (let x = 0; x < width; x += barGap) {
      let min = 1.0;
      let max = -1.0;
      const baseIdx = x * step;
      for (let j = 0; j < step && baseIdx + j < channelData.length; j++) {
        const sample = channelData[baseIdx + j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      if (min > max) {
        min = 0;
        max = 0;
      }
      const inSelection = x >= startX && x <= endX;
      ctx2d.fillStyle = inSelection ? '#63b3ed' : '#475569';
      const yTop = midY + min * (midY * 0.86);
      const barH = Math.max(Math.ceil(1.5 * dpr), (max - min) * (midY * 0.86));
      ctx2d.fillRect(x, yTop, barWidth, barH);
    }

    // Dimmed curtains outside trim region
    ctx2d.fillStyle = 'rgba(15, 23, 42, 0.58)';
    if (startX > 0) ctx2d.fillRect(0, 0, startX, height);
    if (endX < width) ctx2d.fillRect(endX, 0, width - endX, height);

    // Live playhead indicator
    let playheadSec = -1;
    if (isPreviewPlaying && audioCtx) {
      const elapsed = audioCtx.currentTime - previewStartCtxTime;
      if (elapsed >= 0 && elapsed <= previewDurationSec) {
        playheadSec = previewOffsetSec + elapsed;
      }
    } else if (audioPlayer && (!audioPlayer.paused || audioPlayer.currentTime > 0)) {
      playheadSec = audioPlayer.currentTime;
    }

    if (playheadSec >= 0 && playheadSec <= maxDur) {
      const playX = (playheadSec / maxDur) * width;
      ctx2d.fillStyle = '#f6e05e';
      ctx2d.fillRect(playX - Math.floor(dpr), 0, Math.max(2, Math.floor(2 * dpr)), height);
    }

    // Interactive Trim Handles (Start = upper tab, End = lower tab so fingers never collide)
    drawTrimHandle(ctx2d, startX, height, dpr, 'start', draggingHandle === 'start' || hoveredHandle === 'start', width);
    drawTrimHandle(ctx2d, endX, height, dpr, 'end', draggingHandle === 'end' || hoveredHandle === 'end', width);
  }

  function drawTrimHandle(ctx2d, x, height, dpr, kind, isActive, canvasWidth) {
    const lineW = Math.max(2, Math.round(3 * dpr));
    const tabW = Math.round(24 * dpr);
    const tabH = Math.round(38 * dpr);
    const clampedLineX = Math.max(lineW / 2, Math.min(canvasWidth - lineW / 2, x));

    ctx2d.fillStyle = isActive ? '#ffffff' : '#38bdf8';
    ctx2d.fillRect(clampedLineX - lineW / 2, 0, lineW, height);

    const tabY = kind === 'start' ? Math.round(10 * dpr) : height - tabH - Math.round(10 * dpr);
    const tabX = Math.max(2 * dpr, Math.min(canvasWidth - tabW - 2 * dpr, clampedLineX - tabW / 2));

    drawRoundedRect(ctx2d, tabX, tabY, tabW, tabH, Math.round(7 * dpr));
    ctx2d.fillStyle = isActive ? '#ffffff' : '#005eb8';
    ctx2d.fill();
    ctx2d.lineWidth = Math.max(1, Math.round(1.5 * dpr));
    ctx2d.strokeStyle = isActive ? '#005eb8' : '#90cdf4';
    ctx2d.stroke();

    // Tactile grip bars inside handle pill
    ctx2d.fillStyle = isActive ? '#005eb8' : '#ffffff';
    const gripH = Math.round(16 * dpr);
    const gripW = Math.max(1, Math.round(2 * dpr));
    const gripTop = tabY + Math.round((tabH - gripH) / 2);
    const cx = tabX + tabW / 2;
    ctx2d.fillRect(cx - Math.round(4 * dpr), gripTop, gripW, gripH);
    ctx2d.fillRect(cx + Math.round(2 * dpr), gripTop, gripW, gripH);
  }

  // Unified Pointer Events (Touch, Apple Pencil, Chromebook Trackpad, Mouse)
  function pointerXToSeconds(clientX) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return ratio * getMaxDuration();
  }

  function pickHandleForPointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const maxDur = getMaxDuration();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const startX = ((parseFloat(trimStart.value) || 0) / maxDur) * rect.width;
    const endX = ((parseFloat(trimEnd.value) || maxDur) / maxDur) * rect.width;

    const distStart = Math.abs(x - startX);
    const distEnd = Math.abs(x - endX);
    const hitRadius = 32;

    if (distStart <= hitRadius && distEnd <= hitRadius) {
      if (x < startX - 4) return 'start';
      if (x > endX + 4) return 'end';
      return y < rect.height / 2 ? 'start' : 'end';
    }
    if (distStart <= hitRadius) return 'start';
    if (distEnd <= hitRadius) return 'end';
    return distStart <= distEnd ? 'start' : 'end';
  }

  function applyPointerDrag(clientX) {
    if (!draggingHandle || !decodedBuffer) return;
    const sec = pointerXToSeconds(clientX);
    if (draggingHandle === 'start') {
      trimStart.value = sec.toFixed(1);
      updateTrimUI('start');
    } else {
      trimEnd.value = sec.toFixed(1);
      updateTrimUI('end');
    }
  }

  canvas.addEventListener('pointerdown', event => {
    if (!decodedBuffer) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();

    draggingHandle = pickHandleForPointer(event.clientX, event.clientY);
    activePointerId = event.pointerId;
    if (typeof canvas.setPointerCapture === 'function') {
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    }
    applyPointerDrag(event.clientX);
  });

  canvas.addEventListener('pointermove', event => {
    if (!decodedBuffer) return;
    if (draggingHandle && event.pointerId === activePointerId) {
      event.preventDefault();
      applyPointerDrag(event.clientX);
      return;
    }

    // Hover feedback for mouse / trackpad pointers
    if (event.pointerType === 'mouse') {
      const nearest = pickHandleForPointer(event.clientX, event.clientY);
      if (hoveredHandle !== nearest) {
        hoveredHandle = nearest;
        drawWaveform();
      }
    }
  });

  function endPointerDrag(event) {
    if (activePointerId !== null && event.pointerId === activePointerId) {
      if (typeof canvas.releasePointerCapture === 'function') {
        try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
      }
      draggingHandle = null;
      activePointerId = null;
      drawWaveform();
    }
  }

  canvas.addEventListener('pointerup', endPointerDrag);
  canvas.addEventListener('pointercancel', endPointerDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!draggingHandle && hoveredHandle) {
      hoveredHandle = null;
      drawWaveform();
    }
  });

  // Keyboard support when waveform canvas is focused directly
  canvas.addEventListener('keydown', event => {
    if (!decodedBuffer) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      nudgeTrim(event.shiftKey ? 'end' : 'start', -0.1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      nudgeTrim(event.shiftKey ? 'end' : 'start', 0.1);
    }
  });

  window.addEventListener('resize', drawWaveform);

  // =========================================================================
  // 8. Lossless PCM WAV Encoder, Crop & Universal .WAV Export
  // =========================================================================
  function encodeTrimmedWav(buffer, startSec, endSec) {
    const sampleRate = buffer.sampleRate;
    const numChannels = buffer.numberOfChannels;
    const startFrame = Math.max(0, Math.floor(startSec * sampleRate));
    const endFrame = Math.min(buffer.length, Math.floor(endSec * sampleRate));
    const frameCount = Math.max(1, endFrame - startFrame);
    const bytesPerSample = 2; // 16-bit PCM
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = frameCount * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true);  // AudioFormat = 1 (Linear PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // 16 bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }

    let offset = 44;
    for (let i = 0; i < frameCount; i++) {
      const idx = startFrame + i;
      for (let ch = 0; ch < numChannels; ch++) {
        const raw = channels[ch][idx] || 0;
        const sample = Math.max(-1, Math.min(1, raw));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  applyTrimBtn.addEventListener('click', async () => {
    if (!activeRecord || !decodedBuffer) return;
    stopPreviewPlayback();
    if (!audioPlayer.paused) audioPlayer.pause();

    const s = parseFloat(trimStart.value) || 0;
    const e = parseFloat(trimEnd.value) || decodedBuffer.duration;
    const wavBlob = encodeTrimmedWav(decodedBuffer, s, e);

    activeRecord.blob = wavBlob;
    activeRecord.mimeType = 'audio/wav';
    activeRecord.duration = Math.max(MIN_TRIM_GAP, e - s);
    await saveRecordingDB(activeRecord);
    await refreshList(activeRecord.id);
    showToast(`Cropped clip to ${activeRecord.duration.toFixed(1)}s (.WAV updated).`);
  });

  downloadBtn.addEventListener('click', async () => {
    if (!activeRecord || !decodedBuffer) return;

    // Guarantee standard 16-bit RIFF WAVE PCM file export on every browser/OS
    let exportBlob = activeRecord.blob;
    if (!exportBlob || exportBlob.type !== 'audio/wav') {
      exportBlob = encodeTrimmedWav(decodedBuffer, 0, decodedBuffer.duration);
    }

    const safeName = (activeRecord.title || 'recording')
      .replace(/[^a-z0-9\-_ ]/gi, '')
      .trim()
      .replace(/\s+/g, '_') || 'recording';

    const url = URL.createObjectURL(exportBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    showToast(`Downloaded "${safeName}.wav" to your device.`);
  });

  // =========================================================================
  // 9. Accessible Confirmation Dialog (Delete & Shared-Device Clear All)
  // =========================================================================
  function openConfirmDialog({ title, message, confirmLabel, onConfirm }) {
    confirmDialogTitle.textContent = title;
    confirmDialogMsg.textContent = message;
    confirmAcceptBtn.textContent = confirmLabel;
    pendingConfirmAction = onConfirm;

    if (typeof confirmDialog.showModal === 'function') {
      confirmDialog.showModal();
    } else {
      confirmDialog.setAttribute('open', '');
    }
    confirmCancelBtn.focus();
  }

  function closeConfirmDialog() {
    pendingConfirmAction = null;
    if (typeof confirmDialog.close === 'function' && confirmDialog.open) {
      confirmDialog.close();
    } else {
      confirmDialog.removeAttribute('open');
    }
  }

  confirmCancelBtn.addEventListener('click', closeConfirmDialog);
  confirmAcceptBtn.addEventListener('click', async () => {
    const action = pendingConfirmAction;
    closeConfirmDialog();
    if (typeof action === 'function') {
      await action();
    }
  });

  confirmDialog.addEventListener('click', event => {
    if (event.target === confirmDialog) closeConfirmDialog();
  });

  deleteBtn.addEventListener('click', () => {
    if (!activeRecord) return;
    const targetId = activeRecord.id;
    const targetTitle = activeRecord.title;
    openConfirmDialog({
      title: 'Delete Recording?',
      message: `Permanently delete "${targetTitle}" from this device? This cannot be undone.`,
      confirmLabel: 'Delete Clip',
      onConfirm: async () => {
        stopPreviewPlayback();
        if (!audioPlayer.paused) audioPlayer.pause();
        await deleteRecordingDB(targetId);
        activeRecord = null;
        await refreshList();
      }
    });
  });

  clearAllBtn.addEventListener('click', () => {
    openConfirmDialog({
      title: 'Clear All Recordings on This Device?',
      message: 'This removes every saved recording from local storage so this shared Chromebook or iPad is ready for the next pupil.',
      confirmLabel: 'Clear All Recordings',
      onConfirm: async () => {
        stopPreviewPlayback();
        if (!audioPlayer.paused) audioPlayer.pause();
        await clearAllRecordingsDB();
        activeRecord = null;
        await refreshList();
      }
    });
  });

  // =========================================================================
  // 10. Laptop / Chromebook Keyboard Shortcuts (R & Space)
  // =========================================================================
  function isTypingInField(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = (target.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = (target.type || 'text').toLowerCase();
      return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
    }
    return false;
  }

  window.addEventListener('keydown', event => {
    if (event.repeat) return;
    if (confirmDialog.open || confirmDialog.hasAttribute('open')) return;
    if (isTypingInField(event.target)) return;
    if (event.ctrlKey || event.metaKey) return;

    // 'R' (or Alt+R) starts/stops recording
    if (event.code === 'KeyR') {
      event.preventDefault();
      toggleRecording();
      return;
    }

    // 'Space' plays/pauses preview when not typing in title input
    if (event.code === 'Space' && !event.altKey) {
      const tag = (event.target && event.target.tagName || '').toUpperCase();
      const isLibraryItemBtn = event.target && event.target.closest && event.target.closest('.rec-item');
      const isPlayButton = event.target === playPauseBtn || event.target === mobilePlayBtn;

      // Preserve native Space activation when focused on other buttons or native <audio> controls
      if ((tag === 'BUTTON' && !isLibraryItemBtn && !isPlayButton) || tag === 'AUDIO') {
        return;
      }

      if (activeRecord && !(mediaRecorder && mediaRecorder.state === 'recording')) {
        event.preventDefault();
        toggleMainPlayback();
      }
    }
  });

  // =========================================================================
  // 11. Accessible Status Toast & Initialisation
  // =========================================================================
  function showToast(message, isWarning = false) {
    if (!statusToast) return;
    clearTimeout(toastTimeout);
    statusToast.textContent = message;
    statusToast.style.background = isWarning ? 'var(--danger-soft)' : 'var(--success-soft)';
    statusToast.style.color = isWarning ? 'var(--danger)' : 'var(--success)';
    statusToast.hidden = false;
    toastTimeout = setTimeout(() => {
      statusToast.hidden = true;
    }, 4000);
  }

  async function init() {
    registerServiceWorker();
    updateNetworkBadge();
    initInstallTipBanner();
    await initPersistentStorage();
    await loadMicrophones();
    await refreshList();
  }

  init();
})();
