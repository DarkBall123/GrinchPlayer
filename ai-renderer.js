'use strict';

const {
    TranscriptTracker,
    advanceCallState,
    buildContextText,
    createCallState,
    isCurrentRanking,
    normalizeText,
    rankQuickCandidates,
    sanitizeCallState,
    stabilizeSuggestionSlots
} = require('./ai-core');

const TOP_K = 5;
const PROVISIONAL_DEBOUNCE_MS = 450;
const FINAL_DEADLINE_MS = 1800;
const TRANSCRIPTION_COST_PER_MINUTE = 0.017;
const MAX_CALL_TURNS = 500;
const MAX_SUGGESTION_SNAPSHOTS = 3;

class AiController {
    constructor(options) {
        this.ipcRenderer = options.ipcRenderer;
        this.getPage = options.getPage;
        this.getBlockText = options.getBlockText;
        this.playBlock = options.playBlock;
        this.notify = options.notify;
        this.confirm = options.confirm;
        this.beforeOpen = options.beforeOpen;

        this.mode = 'deck';
        this.modeGeneration = 0;
        this.settings = {
            hasKey: false,
            keySource: 'none',
            inputDeviceId: '',
            scenarios: [],
            activeScenarioId: ''
        };
        this.aiEnabled = false;
        this.captureActive = false;
        this.paused = false;
        this.starting = false;
        this.captureGeneration = 0;
        this.captureSessionToken = '';
        this.acceptTranscriptionEvents = false;
        this.restartRequested = false;
        this.stream = null;
        this.audioContext = null;
        this.audioSource = null;
        this.audioNode = null;
        this.silentGain = null;
        this.tracker = new TranscriptTracker();
        this.turns = new Map();
        this.turnOrder = [];
        this.currentItemId = '';
        this.sessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        this.callState = createCallState();
        this.suggestions = [];
        this.suggestionsFinal = false;
        this.suggestionSource = '';
        this.rankInFlight = false;
        this.rankRequestId = 0;
        this.pendingProvisional = null;
        this.pendingFinal = null;
        this.provisionalTimer = null;
        this.lastProvisionalAt = 0;
        this.finalDeadlineTimer = null;
        this.indexPromise = null;
        this.feedbackQueue = Promise.resolve();
        this.feedbackTombstones = new Set();
        this.feedbackEpoch = 0;
        this.billingStartedAt = null;
        this.billingElapsedMs = 0;
        this.billingTimer = null;
        this.lastStatus = 'stopped';

        this.onAiEvent = (event, payload) => this.handleAiEvent(payload);
        this.onDeviceChange = () => this.refreshInputDevices();
        this.onDocumentClick = (event) => this.handleDocumentClick(event);
    }

    async init() {
        this.elements = {
            deck: document.querySelector('#deck'),
            deckTab: document.querySelector('#deck-mode-tab'),
            aiTab: document.querySelector('#ai-mode-tab'),
            panel: document.querySelector('#ai-panel'),
            status: document.querySelector('#ai-status'),
            statusText: document.querySelector('#ai-status .ai-status-text'),
            sessionCost: document.querySelector('#ai-status .ai-session-cost'),
            pauseButton: document.querySelector('#ai-pause'),
            newCallButton: document.querySelector('#ai-new-call'),
            scenarioSelect: document.querySelector('#ai-scenario-select'),
            scenarioName: document.querySelector('#ai-scenario-name'),
            scenarioPrompt: document.querySelector('#ai-scenario-prompt'),
            scenarioLabel: document.querySelector('#ai-scenario-label'),
            inputDevice: document.querySelector('#ai-input-device'),
            levelBar: document.querySelector('#ai-level-bar'),
            transcript: document.querySelector('#ai-transcript-text'),
            callState: document.querySelector('#ai-call-state'),
            suggestionStage: document.querySelector('#ai-suggestion-stage'),
            suggestionList: document.querySelector('#ai-suggestion-list'),
            feedbackCount: document.querySelector('#ai-feedback-count'),
            settingsModal: document.querySelector('#ai-settings'),
            keyInput: document.querySelector('#ai-api-key'),
            keyStatus: document.querySelector('#ai-key-status')
        };

        this.elements.deckTab.addEventListener('click', () => this.showDeck());
        this.elements.aiTab.addEventListener('click', () => this.showAi());
        this.elements.scenarioSelect.addEventListener('change', () => this.selectScenario());
        document.querySelector('#ai-scenario-new').addEventListener('click', () => this.newScenario());
        document.querySelector('#ai-scenario-save').addEventListener('click', () => this.saveScenario());
        document.querySelector('#ai-scenario-delete').addEventListener('click', () => this.deleteScenario());
        document.querySelector('#ai-scenario-template').addEventListener('click', () => this.applyScenarioTemplate());
        this.elements.inputDevice.addEventListener('change', () => this.changeInputDevice());
        this.elements.pauseButton.addEventListener('click', () => this.togglePause());
        this.elements.newCallButton.addEventListener('click', () => this.newCall());
        document.querySelector('#ai-key-save').addEventListener('click', () => this.saveApiKey());
        document.querySelector('#ai-key-delete').addEventListener('click', () => this.deleteApiKey());
        document.querySelector('#ai-feedback-undo').addEventListener('click', () => this.undoFeedback());
        document.querySelector('#ai-feedback-clear').addEventListener('click', () => this.clearFeedback());
        this.elements.suggestionList.addEventListener('click', (event) => {
            const button = event.target.closest('.ai-suggestion');
            if (button) {
                this.playBlock(button.dataset.hash);
            }
        });

        this.ipcRenderer.on('ai:event', this.onAiEvent);
        document.addEventListener('click', this.onDocumentClick);
        navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);

        await this.refreshSettings();
        await Promise.all([
            this.refreshInputDevices(),
            this.refreshFeedbackStats()
        ]);
        this.renderPauseButton();
        this.renderCallState();
    }

    handleDocumentClick(event) {
        if (event.target.closest('.open-ai-settings')) {
            this.openSettings();
        }
    }

    async refreshSettings() {
        this.settings = await this.ipcRenderer.invoke('ai:settings:get');
        this.elements.keyStatus.textContent = this.settings.keySource === 'environment' ?
            'Используется OPENAI_API_KEY' : this.settings.hasKey ?
                'Локальный ключ сохранён' : 'Ключ не настроен';
        document.querySelector('#ai-key-delete').disabled = this.settings.keySource !== 'local';

        this.renderScenarios();

        if (this.settings.inputDeviceId) {
            this.elements.inputDevice.value = this.settings.inputDeviceId;
        }
    }

    activeScenario() {
        return (this.settings.scenarios || []).find((scenario) => scenario.id === this.settings.activeScenarioId) || null;
    }

    renderScenarios() {
        const scenarios = this.settings.scenarios || [];
        this.elements.scenarioSelect.replaceChildren();

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = scenarios.length > 0 ? 'Выберите сценарий' : 'Создайте сценарий';
        this.elements.scenarioSelect.appendChild(placeholder);

        scenarios.forEach((scenario) => {
            const option = document.createElement('option');
            option.value = scenario.id;
            option.textContent = scenario.name;
            this.elements.scenarioSelect.appendChild(option);
        });

        const active = this.activeScenario();
        this.elements.scenarioSelect.value = active ? active.id : '';
        this.elements.scenarioName.value = active ? active.name : '';
        this.elements.scenarioPrompt.value = active ? active.prompt : '';
        this.elements.scenarioLabel.textContent = active ? active.name : 'не выбран';
    }

    newScenario() {
        this.elements.scenarioSelect.value = '';
        this.elements.scenarioName.value = '';
        this.elements.scenarioPrompt.value = '';
        this.elements.scenarioLabel.textContent = 'новый';
        this.elements.scenarioName.focus();
    }

    applyScenarioTemplate() {
        if (this.elements.scenarioPrompt.value.trim()) {
            this.notify('Поле уже заполнено — шаблон его не перезаписал', true, 2200);
            return;
        }
        this.elements.scenarioPrompt.value = [
            'Легенда:',
            'Цель:',
            'Факты:',
            'Этапы:',
            '1.',
            '2.',
            'Триггеры:',
            'Нельзя:',
            'Колбэки:'
        ].join('\n');
        this.elements.scenarioPrompt.focus();
    }

    async saveScenario() {
        const name = normalizeText(this.elements.scenarioName.value);
        const prompt = this.elements.scenarioPrompt.value.trim();
        if (!name || !prompt) {
            this.notify('Заполните название и план сценария', true, 2200);
            return;
        }

        const id = this.elements.scenarioSelect.value ||
            'scenario-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const scenarios = (this.settings.scenarios || []).filter(function (scenario) { return scenario.id !== id; });
        scenarios.push({id: id, name: name, prompt: prompt, updatedAt: new Date().toISOString()});
        this.settings = await this.ipcRenderer.invoke('ai:settings:set', {
            scenarios: scenarios,
            activeScenarioId: id
        });
        this.renderScenarios();
        this.notify('Сценарий сохранён', false, 1800);
        await this.restartScenarioSession();
    }

    async selectScenario() {
        const scenarioId = this.elements.scenarioSelect.value;
        const previousId = this.settings.activeScenarioId;
        this.settings = await this.ipcRenderer.invoke('ai:settings:set', {activeScenarioId: scenarioId});
        this.renderScenarios();
        if (scenarioId !== previousId) {
            await this.restartScenarioSession();
        }
    }

    async deleteScenario() {
        const scenario = this.activeScenario();
        if (!scenario || this.confirm('Удалить сценарий «' + scenario.name + '»?') !== 1) {
            return;
        }

        const scenarios = this.settings.scenarios.filter(function (item) { return item.id !== scenario.id; });
        const nextId = scenarios.length > 0 ? scenarios[0].id : '';
        this.settings = await this.ipcRenderer.invoke('ai:settings:set', {
            scenarios: scenarios,
            activeScenarioId: nextId
        });
        this.renderScenarios();
        this.notify('Сценарий удалён', false, 1800);
        await this.restartScenarioSession();
    }

    async restartScenarioSession() {
        if (!this.aiEnabled) {
            return;
        }

        this.flushFeedback();
        await this.stopCapture();
        this.clearConversation();
        if (this.activeScenario()) {
            if (this.paused) {
                this.setStatus('paused');
            } else {
                await this.startCapture();
            }
        } else {
            this.setStatus('error', 'Создайте и выберите сценарий пранка');
        }
    }

    async refreshInputDevices() {
        let devices;
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
            this.setStatus('error', 'Не удалось получить список аудиовходов');
            return;
        }

        const inputs = devices.filter(function (device) { return device.kind === 'audioinput'; });
        const selectedId = this.settings.inputDeviceId || '';
        this.elements.inputDevice.replaceChildren();

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = inputs.length > 0 ? 'Выберите аудиовход' : 'Аудиовходы не найдены';
        this.elements.inputDevice.appendChild(placeholder);

        inputs.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || ('Аудиовход ' + (index + 1));
            this.elements.inputDevice.appendChild(option);
        });
        this.elements.inputDevice.value = selectedId;

        if (selectedId && !inputs.some(function (device) { return device.deviceId === selectedId; })) {
            if (this.aiEnabled) {
                await this.stopCapture();
                this.setStatus('error', 'Выбранный AI-вход отключён');
            }
        }
    }

    async changeInputDevice() {
        this.settings = await this.ipcRenderer.invoke('ai:settings:set', {
            inputDeviceId: this.elements.inputDevice.value
        });

        if (this.aiEnabled && !this.paused) {
            await this.restartCapture();
        }
    }

    openSettings() {
        this.elements.keyInput.value = '';
        this.elements.settingsModal.classList.add('is-active');
    }

    async saveApiKey() {
        const apiKey = this.elements.keyInput.value.trim();
        if (!apiKey) {
            this.notify('Вставьте API-ключ', true, 2000);
            return;
        }

        this.settings = await this.ipcRenderer.invoke('ai:settings:set', {apiKey: apiKey});
        this.elements.keyInput.value = '';
        await this.refreshSettings();
        this.elements.settingsModal.classList.remove('is-active');
        this.notify('OpenAI API-ключ сохранён', false, 2000);

        if (this.aiEnabled && !this.paused) {
            await this.restartCapture();
        }
    }

    async deleteApiKey() {
        if (this.confirm('Удалить локальный OpenAI API-ключ?') !== 1) {
            return;
        }

        this.settings = await this.ipcRenderer.invoke('ai:settings:set', {apiKey: ''});
        await this.refreshSettings();
        if (this.aiEnabled) {
            await this.stopCapture();
            this.setStatus('error', 'Добавьте OpenAI API-ключ');
        }
    }

    async showAi() {
        if (this.mode === 'ai') {
            return;
        }

        if (this.beforeOpen) {
            this.beforeOpen();
        }

        const generation = ++this.modeGeneration;
        this.mode = 'ai';
        this.aiEnabled = true;
        this.elements.deck.classList.add('ai-active');
        this.elements.deckTab.classList.remove('is-active');
        this.elements.aiTab.classList.add('is-active');
        await this.refreshSettings();
        await this.refreshInputDevices();
        if (generation === this.modeGeneration && this.mode === 'ai') {
            if (this.paused) {
                this.setStatus('paused');
            } else {
                await this.startCapture();
            }
            this.captureSuggestionSnapshot();
            this.renderPauseButton();
        }
    }

    async showDeck() {
        if (this.mode === 'deck') {
            return;
        }

        ++this.modeGeneration;
        this.flushFeedback();
        this.mode = 'deck';
        this.elements.deck.classList.remove('ai-active');
        this.elements.aiTab.classList.remove('is-active');
        this.elements.deckTab.classList.add('is-active');
    }

    async togglePause() {
        if (this.mode !== 'ai') {
            return;
        }

        if (this.paused) {
            this.paused = false;
            this.renderPauseButton();
            await this.startCapture();
            return;
        }

        this.paused = true;
        this.flushFeedback();
        this.renderPauseButton();
        await this.stopCapture();
        this.setStatus('paused');
    }

    async newCall() {
        if (this.confirm('Начать новый звонок и очистить только контекст разговора?') !== 1) {
            return;
        }

        this.flushFeedback();
        await this.stopCapture();
        this.clearConversation();
        if (this.aiEnabled && !this.paused) {
            await this.startCapture();
        } else if (this.aiEnabled) {
            this.setStatus('paused');
        }
        this.notify('Начат новый звонок', false, 1600);
    }

    renderPauseButton() {
        const button = this.elements && this.elements.pauseButton;
        if (!button) {
            return;
        }

        const label = this.paused ? 'Продолжить AI' : 'Поставить AI на паузу';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.querySelector('i').className = this.paused ? 'fa fa-play' : 'fa fa-pause';
    }

    async startCapture() {
        if (this.starting) {
            if (this.aiEnabled) {
                this.restartRequested = true;
            }
            return;
        }
        if (this.captureActive || !this.aiEnabled || this.paused) {
            return;
        }

        const page = this.getPage();
        if (!page) {
            this.setStatus('error', 'Откройте страницу со звуками');
            return;
        }

        if (!this.activeScenario()) {
            this.setStatus('error', 'Создайте и выберите сценарий пранка');
            return;
        }

        if (!this.settings.hasKey) {
            this.setStatus('error', 'Добавьте OpenAI API-ключ');
            return;
        }

        if (!this.settings.inputDeviceId) {
            this.setStatus('error', 'Выберите отдельный AI-вход');
            return;
        }

        this.starting = true;
        const generation = ++this.captureGeneration;
        const sessionToken = this.sessionId + ':' + generation + ':' + Date.now().toString(36);
        this.captureSessionToken = sessionToken;
        this.acceptTranscriptionEvents = false;
        const inputDeviceId = this.settings.inputDeviceId;
        this.setStatus('connecting', 'Подключение…');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: {exact: inputDeviceId},
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 1
                },
                video: false
            });

            if (!this.aiEnabled || generation !== this.captureGeneration ||
                inputDeviceId !== this.settings.inputDeviceId || !this.settings.hasKey) {
                stream.getTracks().forEach(function (track) { track.stop(); });
                return;
            }

            this.stream = stream;
            this.audioContext = new window.AudioContext();
            await this.audioContext.audioWorklet.addModule('ai-audio-worklet.mjs');
            this.audioSource = this.audioContext.createMediaStreamSource(stream);
            this.audioNode = new window.AudioWorkletNode(this.audioContext, 'grinch-ai-capture', {
                processorOptions: {outputRate: 24000, batchSize: 2400}
            });
            this.silentGain = this.audioContext.createGain();
            this.silentGain.gain.value = 0;
            this.audioSource.connect(this.audioNode);
            this.audioNode.connect(this.silentGain);
            this.silentGain.connect(this.audioContext.destination);
            this.audioNode.port.onmessage = (event) => {
                if (event.data.type === 'audio' && this.captureActive) {
                    this.handleAudioPacket(event.data.pcm, event.data.level);
                }
            };
            stream.getAudioTracks()[0].addEventListener('ended', () => {
                if (this.aiEnabled) {
                    this.stopCapture();
                    this.setStatus('error', 'Выбранный AI-вход отключён');
                }
            });

            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            this.captureActive = true;
            this.ipcRenderer.send('ai:start', sessionToken);
            this.indexCurrentPage();
        } catch (error) {
            await this.stopCapture();
            this.setStatus('error', this.captureErrorMessage(error));
        } finally {
            this.starting = false;
            if (this.restartRequested && this.aiEnabled) {
                this.restartRequested = false;
                this.startCapture();
            }
        }
    }

    async restartCapture() {
        await this.stopCapture();
        if (this.aiEnabled) {
            await this.startCapture();
        }
    }

    async stopCapture() {
        this.captureGeneration += 1;
        const sessionToken = this.captureSessionToken;
        this.captureSessionToken = '';
        this.acceptTranscriptionEvents = false;
        this.ipcRenderer.send('ai:stop', sessionToken);
        this.captureActive = false;
        this.pauseBilling();
        clearTimeout(this.provisionalTimer);
        clearTimeout(this.finalDeadlineTimer);
        this.provisionalTimer = null;
        this.finalDeadlineTimer = null;
        this.closeIncompleteTurn();

        if (this.audioSource) {
            this.audioSource.disconnect();
            this.audioSource = null;
        }
        if (this.audioNode) {
            this.audioNode.disconnect();
            this.audioNode = null;
        }
        if (this.silentGain) {
            this.silentGain.disconnect();
            this.silentGain = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(function (track) { track.stop(); });
            this.stream = null;
        }
        if (this.audioContext) {
            const context = this.audioContext;
            this.audioContext = null;
            await context.close().catch(function () {});
        }

        this.updateLevel(0);
    }

    closeIncompleteTurn() {
        const turn = this.turns.get(this.currentItemId);
        if (!turn || turn.completed) {
            return;
        }

        turn.closed = true;
        turn.rankingSettled = true;
        this.currentItemId = '';
        this.rankRequestId += 1;
        this.rankInFlight = false;
        this.pendingProvisional = null;
        this.pendingFinal = null;

        const latestCompleted = Array.from(this.turns.values())
            .filter(function (candidate) {
                return candidate.completed && normalizeText(candidate.finalTranscript);
            })
            .sort(function (left, right) { return left.startedAt - right.startedAt; })
            .at(-1);
        if (this.elements && this.elements.transcript) {
            this.renderTranscript(latestCompleted ? latestCompleted.finalTranscript : '', Boolean(latestCompleted));
        }
        if (this.elements && this.elements.suggestionList && this.elements.suggestionStage) {
            this.clearSuggestions('Подсказки появятся во время речи');
        }
    }

    handleAudioPacket(pcm, level) {
        this.updateLevel(level);
        if (this.lastStatus === 'connected') {
            this.ipcRenderer.send('ai:audio', pcm, this.captureSessionToken);
        }
    }

    captureErrorMessage(error) {
        if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
            return 'Windows запретил доступ к аудиовходу. Разрешите доступ к микрофону для desktop-приложений.';
        }
        if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
            return 'Выбранный AI-вход не найден';
        }

        return error.message || 'Не удалось запустить AI-аудиовход';
    }

    updateLevel(level) {
        const decibels = level > 0 ? 20 * Math.log10(level) : -60;
        const percent = Math.max(0, Math.min(100, ((decibels + 60) / 60) * 100));
        this.elements.levelBar.style.width = percent + '%';
    }

    setStatus(status, text) {
        if (this.lastStatus === 'connected' && status !== 'connected') {
            this.pauseBilling();
        }
        if (status === 'connected' && this.lastStatus !== 'connected') {
            this.resumeBilling();
        }

        this.lastStatus = status;
        this.elements.status.dataset.status = status;
        this.elements.statusText.textContent = text || this.statusText(status);
    }

    statusText(status) {
        const labels = {
            connecting: 'Подключение…',
            connected: 'AI слушает',
            paused: 'AI на паузе',
            reconnecting: 'Переподключение…',
            stopped: 'AI выключен',
            error: 'Ошибка AI'
        };
        return labels[status] || status;
    }

    resetBilling() {
        clearInterval(this.billingTimer);
        this.billingTimer = null;
        this.billingStartedAt = null;
        this.billingElapsedMs = 0;
        this.renderBilling();
    }

    resumeBilling() {
        if (!this.billingStartedAt) {
            this.billingStartedAt = Date.now();
        }
        if (!this.billingTimer) {
            this.billingTimer = setInterval(() => this.renderBilling(), 1000);
        }
        this.renderBilling();
    }

    pauseBilling() {
        if (this.billingStartedAt) {
            this.billingElapsedMs += Date.now() - this.billingStartedAt;
            this.billingStartedAt = null;
        }
        clearInterval(this.billingTimer);
        this.billingTimer = null;
        this.renderBilling();
    }

    renderBilling() {
        const liveElapsed = this.billingStartedAt ? Date.now() - this.billingStartedAt : 0;
        const elapsed = this.billingElapsedMs + liveElapsed;
        const totalSeconds = Math.floor(elapsed / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        const cost = (elapsed / 60000) * TRANSCRIPTION_COST_PER_MINUTE;

        this.elements.sessionCost.textContent = elapsed > 0 ?
            minutes + ':' + seconds + ' · ~$' + cost.toFixed(2) : '';
    }

    eventMatchesCapture(event) {
        const token = String(event && event.sessionToken || '');
        return !token || token === this.captureSessionToken;
    }

    eventItemId(event) {
        const itemId = String(event && event.itemId || '');
        const token = String(event && event.sessionToken || '');
        return itemId && token ? token + '\u0001' + itemId : itemId;
    }

    handleAiEvent(event) {
        if (!event || !this.eventMatchesCapture(event)) {
            return;
        }

        if (event.type === 'status') {
            this.acceptTranscriptionEvents = event.status === 'connected';
            if (event.status === 'stopped' && this.aiEnabled && this.paused) {
                this.setStatus('paused');
                return;
            }
            if (event.status === 'stopped' && this.aiEnabled && this.lastStatus === 'error') {
                return;
            }
            this.setStatus(event.status);
            return;
        }
        if (event.type === 'error') {
            this.acceptTranscriptionEvents = false;
            this.setStatus('error', this.aiErrorMessage(event.error));
            return;
        }
        if (!this.aiEnabled || this.paused) {
            return;
        }
        if (event.type === 'ranking') {
            this.applyRankingResult(event.result);
            return;
        }
        if (event.type === 'turn_failed') {
            const itemId = this.eventItemId(event);
            const failedTurn = this.turns.get(itemId);
            if (failedTurn) {
                failedTurn.closed = true;
            }
            if (this.currentItemId === itemId) {
                this.currentItemId = '';
                this.clearSuggestions('Не удалось распознать реплику');
                this.renderTranscript('Ожидаю следующую реплику…', false);
            }
            this.notify(this.aiErrorMessage(event.error || {}), true, 1800);
            return;
        }
        if (!this.acceptTranscriptionEvents) {
            return;
        }

        const itemId = this.eventItemId(event);
        const trackedEvent = itemId === event.itemId ? event : Object.assign({}, event, {itemId: itemId});
        const tracked = this.tracker.handle(trackedEvent);
        if (!tracked) {
            return;
        }
        if (event.type === 'transcript_delta' && typeof event.transcript === 'string') {
            tracked.transcript = event.transcript;
            const stored = this.tracker.turns.get(tracked.itemId);
            if (stored) {
                stored.transcript = event.transcript;
            }
        }

        const turn = this.ensureTurn(tracked.itemId, tracked.startedAt || event.timestamp);
        if (tracked.startedAt) {
            turn.startedAt = tracked.startedAt;
        }
        turn.transcript = tracked.transcript;
        turn.completed = tracked.completed;

        if (event.type === 'speech_started') {
            if (this.shouldBeginTurn(turn)) {
                this.beginTurn(turn);
            }
        } else if (event.type === 'speech_stopped') {
            turn.stoppedAt = tracked.stoppedAt || Date.now();
            if (this.currentItemId === turn.itemId) {
                this.scheduleFinalDeadline(turn);
                clearTimeout(this.provisionalTimer);
                this.provisionalTimer = null;
                this.requestRanking(turn, false);
            }
        } else if (event.type === 'transcript_delta') {
            turn.revision += 1;
            if (this.shouldBeginTurn(turn)) {
                this.beginTurn(turn);
            }
            if (this.currentItemId === turn.itemId) {
                this.renderTranscript(turn.transcript, false);
                this.scheduleProvisional(turn);
            }
        } else if (event.type === 'transcript_completed') {
            turn.revision += 1;
            turn.finalTranscript = tracked.transcript;

            if (this.shouldBeginTurn(turn)) {
                this.beginTurn(turn);
            }

            const rerankTurn = this.rebuildConversationState(turn);
            this.saveFeedback(turn);
            this.linkTurnOutcomes();

            if (this.currentItemId === turn.itemId) {
                this.renderTranscript(turn.finalTranscript, true);
                if (this.suggestions.length === 0 && !this.rankInFlight) {
                    this.pendingFinal = turn;
                    this.requestRanking(turn, false);
                } else {
                    this.requestRanking(turn, true);
                }
                if (!turn.stoppedAt) {
                    turn.stoppedAt = Date.now();
                    this.scheduleFinalDeadline(turn);
                }
            } else if (rerankTurn) {
                this.requestRanking(rerankTurn, true);
            }
        }
    }

    shouldBeginTurn(turn) {
        if (!this.currentItemId) {
            return true;
        }
        if (this.currentItemId === turn.itemId) {
            return false;
        }

        const current = this.turns.get(this.currentItemId);
        return !current || turn.startedAt >= current.startedAt;
    }

    aiErrorMessage(error) {
        const messages = {
            missing_api_key: 'Добавьте OpenAI API-ключ',
            invalid_api_key: 'OpenAI отклонил API-ключ',
            insufficient_quota: 'На OpenAI API закончился баланс',
            rate_limit_exceeded: 'Превышен лимит OpenAI API',
            reconnect_failed: 'Не удалось восстановить соединение',
            missing_scenario: 'Создайте и выберите сценарий пранка',
            timeout: 'OpenAI не ответил вовремя'
        };
        return messages[error.code] || error.message || 'Ошибка OpenAI';
    }

    ensureTurn(itemId, timestamp) {
        let turn = this.turns.get(itemId);
        if (!turn) {
            const page = this.getPage();
            const scenario = this.activeScenario();
            turn = {
                itemId: itemId,
                turnId: this.sessionId + ':' + itemId,
                pageHash: page ? page.pageHash : '',
                scenarioId: scenario ? scenario.id : '',
                startedAt: timestamp || Date.now(),
                stoppedAt: null,
                transcript: '',
                finalTranscript: '',
                context: '',
                completed: false,
                closed: false,
                revision: 0,
                deadlineExpired: false,
                rankingSettled: false,
                played: new Map(),
                playedEvents: [],
                suggestionSnapshots: new Map(),
                feedbackSignatures: new Map(),
                feedbackEpoch: this.feedbackEpoch,
                feedbackRootId: '',
                feedbackEligible: true,
                callState: sanitizeCallState(this.callState),
                stateAdvanced: false,
                nextTranscript: ''
            };
            if (this.feedbackEpoch > 0) {
                turn.feedbackRootId = turn.turnId + ':feedback:' + this.feedbackEpoch;
            }
            this.turns.set(itemId, turn);
            this.turnOrder.push(itemId);
        }

        return turn;
    }

    beginTurn(turn) {
        if (this.currentItemId && this.currentItemId !== turn.itemId) {
            const previous = this.turns.get(this.currentItemId);
            if (previous) {
                previous.closed = true;
                this.saveFeedback(previous);
            }
        }

        this.currentItemId = turn.itemId;
        turn.closed = false;
        const page = this.getPage();
        const scenario = this.activeScenario();
        turn.pageHash = page ? page.pageHash : '';
        turn.scenarioId = scenario ? scenario.id : '';
        turn.callState = sanitizeCallState(this.callState);
        clearTimeout(this.finalDeadlineTimer);
        this.finalDeadlineTimer = null;
        this.pendingProvisional = null;
        this.pendingFinal = null;
        this.lastProvisionalAt = 0;
        this.clearSuggestions('Подбираю варианты…');
        this.renderTranscript('Слушаю…', false);
        this.trimTurns();
    }

    trimTurns() {
        while (this.turnOrder.length > MAX_CALL_TURNS) {
            const itemId = this.turnOrder.shift();
            if (itemId !== this.currentItemId) {
                this.turns.delete(itemId);
                this.tracker.turns.delete(itemId);
            }
        }
    }

    historyFor(turn) {
        return this.turnOrder
            .map((itemId) => this.turns.get(itemId))
            .filter(function (candidate) {
                return candidate && candidate.itemId !== turn.itemId && candidate.completed &&
                    candidate.startedAt <= turn.startedAt && candidate.scenarioId === turn.scenarioId;
            })
            .sort(function (left, right) { return left.startedAt - right.startedAt; })
            .map((candidate) => ({
                turnId: candidate.turnId,
                transcript: candidate.finalTranscript,
                played: Array.isArray(candidate.playedEvents) && candidate.playedEvents.length > 0 ?
                    candidate.playedEvents.slice() : Array.from(candidate.played.values())
            }));
    }

    rebuildConversationState(completedTurn) {
        const order = new Map(this.turnOrder.map(function (itemId, index) { return [itemId, index]; }));
        const completed = Array.from(this.turns.values())
            .filter(function (turn) {
                return turn.completed && normalizeText(turn.finalTranscript);
            })
            .sort(function (left, right) {
                return left.startedAt - right.startedAt ||
                    (order.get(left.itemId) || 0) - (order.get(right.itemId) || 0);
            });
        const completedIndex = completed.indexOf(completedTurn);
        const historyByScenario = new Map();
        const affected = [];
        let state = createCallState();

        completed.forEach((turn, index) => {
            const scenarioId = turn.scenarioId || '';
            const history = historyByScenario.get(scenarioId) || [];
            const context = buildContextText(history, turn.finalTranscript);
            state = advanceCallState(state, turn.finalTranscript);
            const callState = sanitizeCallState(state);
            const changed = turn.context !== context ||
                JSON.stringify(sanitizeCallState(turn.callState)) !== JSON.stringify(callState);

            turn.context = context;
            turn.callState = callState;
            turn.stateAdvanced = true;
            if (changed && completedIndex >= 0 && index > completedIndex) {
                turn.revision += 1;
                turn.rankingSettled = false;
                if (turn.feedbackSignatures instanceof Map) {
                    turn.feedbackSignatures.clear();
                }
                affected.push(turn);
            }

            history.push({
                turnId: turn.turnId,
                transcript: turn.finalTranscript,
                played: Array.isArray(turn.playedEvents) && turn.playedEvents.length > 0 ?
                    turn.playedEvents.slice() : Array.from(turn.played.values())
            });
            historyByScenario.set(scenarioId, history);
        });

        this.callState = sanitizeCallState(state);
        this.renderCallState();
        affected.forEach((turn) => this.saveFeedback(turn));
        return affected.find((turn) => turn.itemId === this.currentItemId && turn.completed) || null;
    }

    renderTranscript(text, final) {
        this.elements.transcript.textContent = normalizeText(text) || 'Ожидаю речь…';
        this.elements.transcript.classList.toggle('is-final', Boolean(final));
    }

    renderCallState() {
        if (!this.elements || !this.elements.callState) {
            return;
        }
        const state = sanitizeCallState(this.callState);
        const phases = {
            opening: 'вход',
            engagement: 'зацепка',
            development: 'развитие',
            escalation: 'эскалация',
            closing: 'завершение'
        };
        this.elements.callState.textContent = 'Этап: ' + phases[state.phase] +
            (state.activeTopic ? ' · тема: ' + state.activeTopic : '');
    }

    linkTurnOutcomes() {
        const completed = Array.from(this.turns.values())
            .filter(function (turn) { return turn.completed && normalizeText(turn.finalTranscript); })
            .sort(function (left, right) { return left.startedAt - right.startedAt; });

        for (let index = 0; index < completed.length - 1; index++) {
            const turn = completed[index];
            const next = completed[index + 1];
            const rootTurnId = this.feedbackRootId(turn);
            if (turn.scenarioId !== next.scenarioId || turn.nextTranscript === next.finalTranscript ||
                this.feedbackTombstones.has(rootTurnId)) {
                continue;
            }
            const previousTranscript = turn.nextTranscript;
            turn.nextTranscript = next.finalTranscript;
            this.feedbackQueue = this.feedbackQueue
                .then(() => this.ipcRenderer.invoke('ai:feedback:next', {
                    rootTurnId: rootTurnId,
                    transcript: next.finalTranscript
                }))
                .then((stats) => this.renderFeedbackStats(stats))
                .catch(() => {
                    if (turn.nextTranscript === next.finalTranscript) {
                        turn.nextTranscript = previousTranscript;
                    }
                    this.notify('Не удалось связать следующий ответ', true, 1800);
                });
        }
    }

    scheduleProvisional(turn) {
        if (this.provisionalTimer) {
            return;
        }

        const delay = Math.max(0, PROVISIONAL_DEBOUNCE_MS - (Date.now() - this.lastProvisionalAt));
        this.provisionalTimer = setTimeout(() => {
            this.provisionalTimer = null;
            this.lastProvisionalAt = Date.now();
            this.requestRanking(turn, false);
        }, delay);
    }

    scheduleFinalDeadline(turn) {
        clearTimeout(this.finalDeadlineTimer);
        const remaining = Math.max(0, (turn.stoppedAt + FINAL_DEADLINE_MS) - Date.now());
        this.finalDeadlineTimer = setTimeout(() => {
            turn.deadlineExpired = true;
            if (turn.rankingSettled || !this.isTurnVisible(turn)) {
                return;
            }
            if (this.suggestions.length > 0) {
                this.renderSuggestions(this.suggestions, true, 'semantic');
                return;
            }

            const page = this.getPage();
            const scenario = this.activeScenario();
            const recentHashes = this.historyFor(turn).flatMap(function (historyTurn) {
                return (historyTurn.played || []).map(function (item) { return item.hash || item.blockHash; });
            }).concat(Array.from(turn.played.values()).map(function (item) { return item.hash || item.blockHash; }))
                .filter(Boolean);
            const suggestions = rankQuickCandidates(
                page ? page.candidates : [],
                turn.finalTranscript || turn.transcript,
                scenario ? scenario.prompt : '',
                {recentHashes: recentHashes},
                TOP_K
            );
            if (suggestions.length > 0) {
                this.renderSuggestions(suggestions, true, 'local');
            }
        }, remaining);
    }

    async requestRanking(turn, final) {
        const transcript = final ? turn.finalTranscript : turn.transcript;
        const scenario = this.activeScenario();
        if (!normalizeText(transcript) || !turn.pageHash || !scenario || scenario.id !== turn.scenarioId) {
            return;
        }

        if (this.rankInFlight) {
            if (final) {
                this.pendingFinal = turn;
            } else {
                this.pendingProvisional = turn;
            }
            return;
        }

        const page = this.getPage();
        if (!page || page.pageHash !== turn.pageHash || page.candidates.length === 0) {
            return;
        }

        this.rankInFlight = true;
        const rankRequestId = ++this.rankRequestId;
        const history = this.historyFor(turn);
        const context = final && turn.context ? turn.context : buildContextText(history, transcript);
        const expected = {
            turnId: turn.turnId,
            pageHash: turn.pageHash,
            revision: turn.revision
        };

        try {
            const result = await this.ipcRenderer.invoke('ai:rank', {
                turnId: turn.turnId,
                pageHash: turn.pageHash,
                revision: turn.revision,
                transcript: transcript,
                context: context,
                scenario: scenario,
                pageName: page.pageName || page.pageHash,
                history: history,
                played: Array.isArray(turn.playedEvents) ? turn.playedEvents.slice() : Array.from(turn.played.values()),
                callState: turn.callState || this.callState,
                candidates: page.candidates,
                final: final
            });

            if (!turn.rankingSettled && isCurrentRanking(result, expected) &&
                turn.revision === expected.revision && this.isTurnVisible(turn)) {
                this.renderSuggestions(result.suggestions, result.final || turn.deadlineExpired, result.source);
            }
        } catch {
            if (final && this.isTurnVisible(turn) && this.suggestions.length > 0) {
                this.renderSuggestions(this.suggestions, true, 'semantic');
            }
        } finally {
            if (rankRequestId !== this.rankRequestId) {
                return;
            }

            this.rankInFlight = false;
            const finalTurn = this.pendingFinal;
            const provisionalTurn = this.pendingProvisional;
            this.pendingFinal = null;
            this.pendingProvisional = null;

            if (finalTurn && this.isTurnVisible(finalTurn)) {
                this.requestRanking(finalTurn, true);
            } else if (provisionalTurn && this.isTurnVisible(provisionalTurn) && !provisionalTurn.completed) {
                this.requestRanking(provisionalTurn, false);
            }
        }
    }

    isTurnVisible(turn) {
        const page = this.getPage();
        const scenario = this.activeScenario();
        return this.aiEnabled && !this.paused && this.currentItemId === turn.itemId && page && scenario &&
            page.pageHash === turn.pageHash && scenario.id === turn.scenarioId;
    }

    applyRankingResult(result) {
        if (!result || !result.final) {
            return;
        }

        const turn = Array.from(this.turns.values()).find(function (candidate) {
            return candidate.turnId === result.turnId;
        });
        const expected = turn && {
            turnId: turn.turnId,
            pageHash: turn.pageHash,
            revision: turn.revision
        };

        if (!turn || turn.rankingSettled || !isCurrentRanking(result, expected) || !this.isTurnVisible(turn)) {
            return;
        }

        turn.rankingSettled = true;
        clearTimeout(this.finalDeadlineTimer);
        this.finalDeadlineTimer = null;
        this.callState = sanitizeCallState(result.callState || this.callState);
        turn.callState = sanitizeCallState(this.callState);
        this.renderCallState();
        this.renderSuggestions(result.suggestions, true, result.source);
    }

    renderSuggestions(suggestions, final, source) {
        const page = this.getPage();
        const candidates = new Map((page && page.candidates || []).map(function (candidate) {
            return [candidate.hash, candidate];
        }));
        const seen = new Set();
        const resolved = (suggestions || [])
            .filter(function (suggestion) {
                if (!suggestion || !candidates.has(suggestion.hash) || seen.has(suggestion.hash)) {
                    return false;
                }
                seen.add(suggestion.hash);
                return true;
            })
            .map(function (suggestion) {
                return Object.assign({}, candidates.get(suggestion.hash), {
                    tactic: suggestion.tactic || 'scenario'
                });
            })
            .slice(0, TOP_K);
        const next = this.suggestions.length > 0 ?
            stabilizeSuggestionSlots(this.suggestions, resolved, TOP_K) : resolved;
        const sameOrder = next.length === this.suggestions.length && next.every((candidate, index) => {
            return this.suggestions[index] && this.suggestions[index].hash === candidate.hash;
        });
        this.suggestions = next;
        this.suggestionsFinal = Boolean(final);
        this.suggestionSource = source || '';
        this.elements.suggestionStage.textContent = final ? (source === 'model' ? 'AI' : 'быстрый результат') : 'черновик';

        if (this.suggestions.length === 0) {
            this.clearSuggestions('Подходящих звуков не найдено');
            return;
        }

        const existing = new Map(Array.from(this.elements.suggestionList.querySelectorAll('.ai-suggestion'))
            .map(function (button) { return [button.dataset.hash, button]; }));
        const buttons = this.suggestions.map((suggestion, index) => {
            const button = existing.get(suggestion.hash) || document.createElement('button');
            this.updateSuggestionButton(button, suggestion, index, final);
            return button;
        });
        if (!sameOrder || existing.size !== buttons.length) {
            this.elements.suggestionList.replaceChildren(...buttons);
        }
        this.captureSuggestionSnapshot();
    }

    updateSuggestionButton(button, suggestion, index, final) {
        button.className = 'button ai-suggestion' + (final ? ' is-final' : ' is-provisional');
        button.dataset.hash = suggestion.hash;
        let key = button.querySelector('.ai-suggestion-key');
        let text = button.querySelector('.ai-suggestion-text');
        let tactic = button.querySelector('.ai-suggestion-tactic');
        if (!key) {
            key = document.createElement('span');
            key.className = 'ai-suggestion-key';
            text = document.createElement('span');
            text.className = 'ai-suggestion-text';
            tactic = document.createElement('span');
            tactic.className = 'ai-suggestion-tactic';
            button.append(key, text, tactic);
        }
        const labels = {
            opening: 'вход',
            direct: 'ответ',
            counter: 'встречный',
            repair: 'уточнение',
            neutral: 'нейтрально',
            scenario: 'сценарий',
            escalation: 'нажим',
            callback: 'callback',
            exit: 'выход'
        };
        key.textContent = String(index + 1);
        text.textContent = suggestion.text;
        tactic.textContent = labels[suggestion.tactic] || suggestion.tactic || '';
    }

    suggestionSnapshotHistory(turn, pageHash) {
        if (!turn || !(turn.suggestionSnapshots instanceof Map)) {
            return [];
        }
        const stored = turn.suggestionSnapshots.get(pageHash);
        return Array.isArray(stored) ? stored.slice() : stored ? [stored] : [];
    }

    boundedSuggestionSnapshots(snapshots) {
        const history = Array.isArray(snapshots) ? snapshots : [];
        const firstVisible = history.find(function (snapshot) { return snapshot.visible; });
        const tail = history.filter(function (snapshot) { return snapshot !== firstVisible; })
            .slice(-(MAX_SUGGESTION_SNAPSHOTS - (firstVisible ? 1 : 0)));
        return (firstVisible ? [firstVisible].concat(tail) : tail).sort(function (left, right) {
            return String(left.shownAt).localeCompare(String(right.shownAt));
        });
    }

    captureSuggestionSnapshot() {
        if (!this.currentItemId || this.suggestions.length === 0) {
            return;
        }
        const turn = this.turns.get(this.currentItemId);
        const page = this.getPage();
        if (!turn || !page || turn.pageHash !== page.pageHash) {
            return;
        }
        if (!(turn.suggestionSnapshots instanceof Map)) {
            turn.suggestionSnapshots = new Map();
        }
        const snapshot = {
            pageHash: page.pageHash,
            ids: this.suggestions.map(function (suggestion) { return suggestion.hash; }),
            source: this.suggestionSource,
            final: this.suggestionsFinal,
            visible: this.mode === 'ai',
            shownAt: new Date().toISOString(),
            revision: turn.revision,
            callState: sanitizeCallState(this.callState)
        };
        const history = this.suggestionSnapshotHistory(turn, page.pageHash);
        const previous = history.at(-1);
        const unchanged = previous && previous.visible === snapshot.visible && previous.final === snapshot.final &&
            previous.source === snapshot.source && previous.revision === snapshot.revision &&
            (Array.isArray(previous.ids) ? previous.ids : []).join('\u0000') === snapshot.ids.join('\u0000');
        if (!unchanged) {
            history.push(snapshot);
            turn.suggestionSnapshots.set(page.pageHash, this.boundedSuggestionSnapshots(history));
        }
        if (turn.completed) {
            this.saveFeedback(turn);
        }
    }

    clearSuggestions(message) {
        this.suggestions = [];
        this.suggestionsFinal = false;
        this.suggestionSource = '';
        this.elements.suggestionStage.textContent = '';
        this.elements.suggestionList.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'ai-empty';
        empty.textContent = message || 'Подсказки появятся во время речи';
        this.elements.suggestionList.appendChild(empty);
    }

    recordPlayed(hash) {
        if (!this.aiEnabled || this.paused || !this.currentItemId) {
            return;
        }

        const turn = this.turns.get(this.currentItemId);
        const scenario = this.activeScenario();
        const page = this.getPage();
        const candidate = page && page.candidates.find(function (item) { return item.hash === hash; });
        if (!turn || !scenario || scenario.id !== turn.scenarioId || !page || page.pageHash !== turn.pageHash ||
            !candidate) {
            return;
        }

        const text = this.getBlockText(turn.pageHash, hash);
        if (!text) {
            return;
        }

        const now = Date.now();
        turn.feedbackEligible = true;
        const snapshots = this.suggestionSnapshotHistory(turn, page.pageHash);
        const snapshot = snapshots.find(function (item) { return item.visible; }) || null;
        const suggestionsWereVisible = this.mode === 'ai' && this.suggestions.length > 0;
        const suggestedIds = suggestionsWereVisible ? this.suggestions.map(function (item) { return item.hash; }) : [];
        const playedKey = page.pageHash + '\u0000' + hash;
        const event = {
            hash: hash,
            blockHash: hash,
            text: text,
            pageHash: page.pageHash,
            character: page.pageName || page.pageHash,
            suggestedIds: suggestedIds,
            outsideTopK: suggestionsWereVisible ? !suggestedIds.includes(hash) : null,
            clickedAt: new Date(now).toISOString(),
            playedAt: new Date(now).toISOString(),
            clickLatencyMs: Math.max(0, now - turn.startedAt),
            postSpeechLatencyMs: turn.stoppedAt ? Math.max(0, now - turn.stoppedAt) : null,
            suggestionLatencyMs: snapshot && snapshot.shownAt ?
                Math.max(0, Date.parse(snapshot.shownAt) - turn.startedAt) : null,
            source: suggestionsWereVisible ? this.suggestionSource : '',
            final: suggestionsWereVisible ? this.suggestionsFinal : false,
            repeatCount: 1,
            callState: sanitizeCallState(this.callState)
        };
        if (!Array.isArray(turn.playedEvents)) {
            turn.playedEvents = [];
        }
        turn.playedEvents.push({
            hash: hash,
            text: text,
            pageHash: page.pageHash,
            character: page.pageName || page.pageHash,
            playedAt: event.playedAt
        });
        const existing = turn.played.get(playedKey);
        if (existing) {
            existing.repeatCount = (existing.repeatCount || 1) + 1;
            const existingStrength = existing.outsideTopK === true ? 2 : existing.outsideTopK === false ? 1 : 0;
            const eventStrength = event.outsideTopK === true ? 2 : event.outsideTopK === false ? 1 : 0;
            if (eventStrength > existingStrength) {
                const repeatCount = existing.repeatCount;
                Object.assign(existing, event, {repeatCount: repeatCount});
            }
        } else {
            turn.played.set(playedKey, event);
        }
        if (turn.completed) {
            this.saveFeedback(turn);
        }
    }

    saveFeedback(turn) {
        const rootTurnId = this.feedbackRootId(turn);
        if (!turn || !turn.completed || !turn.context || turn.feedbackEligible === false ||
            this.feedbackTombstones.has(rootTurnId)) {
            return;
        }

        const byPage = new Map();
        turn.played.forEach(function (item) {
            if (!item.pageHash) {
                return;
            }
            if (!byPage.has(item.pageHash)) {
                byPage.set(item.pageHash, []);
            }
            byPage.get(item.pageHash).push(item);
        });
        if (turn.suggestionSnapshots instanceof Map) {
            turn.suggestionSnapshots.forEach(function (snapshots, pageHash) {
                if (!byPage.has(pageHash)) {
                    byPage.set(pageHash, []);
                }
            });
        }
        if (turn.pageHash && !byPage.has(turn.pageHash)) {
            byPage.set(turn.pageHash, []);
        }

        byPage.forEach((selections, pageHash) => {
            const snapshots = this.suggestionSnapshotHistory(turn, pageHash);
            const payload = {
                turnId: rootTurnId + '\u0000' + pageHash,
                rootTurnId: rootTurnId,
                pageHash: pageHash,
                scenarioId: turn.scenarioId,
                transcript: turn.finalTranscript,
                context: turn.context,
                selections: selections,
                suggestionSnapshots: snapshots,
                callState: turn.callState || this.callState,
                nextTranscript: turn.nextTranscript,
                startedAt: new Date(turn.startedAt || Date.now()).toISOString(),
                completedAt: new Date(turn.stoppedAt || Date.now()).toISOString()
            };
            if (!(turn.feedbackSignatures instanceof Map)) {
                turn.feedbackSignatures = new Map();
            }
            const signature = JSON.stringify({
                transcript: payload.transcript,
                context: payload.context,
                selections: payload.selections,
                suggestionSnapshots: payload.suggestionSnapshots,
                callState: payload.callState,
                nextTranscript: payload.nextTranscript
            });
            if (turn.feedbackSignatures.get(pageHash) === signature) {
                return;
            }
            turn.feedbackSignatures.set(pageHash, signature);

            this.feedbackQueue = this.feedbackQueue
                .then(() => this.ipcRenderer.invoke('ai:feedback:save', payload))
                .then((stats) => this.renderFeedbackStats(stats))
                .catch(() => {
                    if (turn.feedbackSignatures.get(pageHash) === signature) {
                        turn.feedbackSignatures.delete(pageHash);
                    }
                    this.notify('Не удалось сохранить AI-пример', true, 2000);
                });
        });
    }

    feedbackRootId(turn) {
        return turn && (turn.feedbackRootId || turn.turnId) || '';
    }

    flushFeedback() {
        this.turns.forEach((turn) => this.saveFeedback(turn));
    }

    async refreshFeedbackStats() {
        const stats = await this.ipcRenderer.invoke('ai:feedback:stats');
        this.renderFeedbackStats(stats);
    }

    renderFeedbackStats(stats) {
        const result = stats && stats.stats ? stats.stats : stats || {};
        const unique = Number(result.unique) || 0;
        const selections = Number(result.selections) || 0;
        const observations = Number(result.observations) || 0;
        const turns = Number(result.turns) || 0;
        this.elements.feedbackCount.textContent = 'Примеров: ' + unique + ' · выборов: ' + selections +
            ' · ходов: ' + observations;
        document.querySelector('#ai-feedback-undo').disabled = turns === 0;
        document.querySelector('#ai-feedback-clear').disabled = unique === 0 && observations === 0;
    }

    latestLocalFeedbackTurnId() {
        const turns = Array.from(this.turns.values()).filter((turn) => {
            return turn && turn.completed && turn.context && turn.played instanceof Map && turn.played.size > 0 &&
                !this.feedbackTombstones.has(this.feedbackRootId(turn));
        }).sort(function (left, right) {
            return (Number(left.startedAt) || 0) - (Number(right.startedAt) || 0);
        });
        return turns.length > 0 ? this.feedbackRootId(turns.at(-1)) : '';
    }

    async undoFeedback() {
        await this.feedbackQueue;
        const fallbackTurnId = this.latestLocalFeedbackTurnId();
        if (fallbackTurnId) {
            this.feedbackTombstones.add(fallbackTurnId);
        }
        try {
            const stats = await this.ipcRenderer.invoke('ai:feedback:undo');
            const rootTurnId = String(stats && stats.rootTurnId || fallbackTurnId);
            if (fallbackTurnId && rootTurnId && fallbackTurnId !== rootTurnId) {
                this.feedbackTombstones.delete(fallbackTurnId);
            }
            if (rootTurnId) {
                this.feedbackTombstones.add(rootTurnId);
            }
            this.renderFeedbackStats(stats);
            this.notify('Последняя обучающая реплика отменена', false, 1800);
        } catch {
            if (fallbackTurnId) {
                this.feedbackTombstones.delete(fallbackTurnId);
            }
            this.notify('Не удалось отменить последнюю обучающую реплику', true, 2000);
        }
    }

    async clearFeedback() {
        if (this.confirm('Удалить все AI-примеры?') !== 1) {
            return;
        }

        const addedTombstones = [];
        this.feedbackEpoch += 1;
        this.turns.forEach((turn) => {
            const rootTurnId = this.feedbackRootId(turn);
            if (turn.completed && !this.feedbackTombstones.has(rootTurnId)) {
                this.feedbackTombstones.add(rootTurnId);
                addedTombstones.push(rootTurnId);
            }
            if (turn.itemId === this.currentItemId && !turn.closed) {
                turn.feedbackEpoch = this.feedbackEpoch;
                turn.feedbackRootId = turn.turnId + ':feedback:' + this.feedbackEpoch;
                turn.feedbackEligible = true;
                turn.played = new Map();
                turn.playedEvents = [];
                turn.suggestionSnapshots = new Map();
                turn.feedbackSignatures = new Map();
                turn.nextTranscript = '';
            }
        });
        this.feedbackQueue = this.feedbackQueue
            .then(() => this.ipcRenderer.invoke('ai:feedback:clear'))
            .then((stats) => {
                this.renderFeedbackStats(stats);
                this.notify('AI-примеры очищены', false, 1800);
            })
            .catch(() => {
                addedTombstones.forEach((turnId) => this.feedbackTombstones.delete(turnId));
                this.notify('Не удалось очистить AI-примеры', true, 2000);
            });
        await this.feedbackQueue;
    }

    async indexCurrentPage() {
        const page = this.getPage();
        if (!page || !this.settings.hasKey) {
            return;
        }

        this.indexPromise = this.ipcRenderer.invoke('ai:index-page', page).catch((error) => {
            this.setStatus('error', error.message || 'Не удалось индексировать текущую страницу');
        });
        await this.indexPromise;
    }

    async pageChanged() {
        if (!this.aiEnabled) {
            return;
        }

        this.flushFeedback();
        const page = this.getPage();
        if (!page) {
            this.clearSuggestions('Откройте страницу со звуками');
            await this.stopCapture();
            this.setStatus('error', 'Откройте страницу со звуками');
            return;
        }
        if (!this.activeScenario()) {
            await this.stopCapture();
            this.setStatus('error', 'Создайте и выберите сценарий пранка');
            return;
        }

        const turn = this.turns.get(this.currentItemId);
        const characterChanged = turn && turn.pageHash !== page.pageHash;
        if (characterChanged) {
            turn.pageHash = page.pageHash;
            turn.revision += 1;
            turn.rankingSettled = false;
            this.pendingProvisional = null;
            this.pendingFinal = null;
            this.lastProvisionalAt = 0;
            this.clearSuggestions('Переключаю персонажа…');
        }

        if (!this.paused) {
            await this.indexCurrentPage();
        }
        if (!this.paused && !this.captureActive && !this.starting) {
            await this.startCapture();
        }

        if (this.paused || !characterChanged) {
            return;
        }

        const hasFinalTranscript = turn.completed && normalizeText(turn.finalTranscript);
        if (hasFinalTranscript) {
            turn.deadlineExpired = true;
            this.requestRanking(turn, true);
        } else if (normalizeText(turn.transcript)) {
            this.requestRanking(turn, false);
        }
    }

    migratePage(oldHash, newHash) {
        this.ipcRenderer.invoke('ai:page:migrate', {oldHash: oldHash, newHash: newHash});
        const page = this.getPage();
        this.turns.forEach((turn) => {
            if (turn.pageHash === oldHash) {
                turn.pageHash = newHash;
            }
            const migrated = new Map();
            turn.played.forEach(function (item) {
                if (item.pageHash === oldHash) {
                    item.pageHash = newHash;
                    item.character = page && page.pageHash === newHash ? page.pageName || newHash : item.character;
                }
                migrated.set(item.pageHash + '\u0000' + item.hash, item);
            });
            turn.played = migrated;
            if (Array.isArray(turn.playedEvents)) {
                turn.playedEvents.forEach(function (item) {
                    if (item.pageHash === oldHash) {
                        item.pageHash = newHash;
                        item.character = page && page.pageHash === newHash ? page.pageName || newHash : item.character;
                    }
                });
            }
            if (turn.suggestionSnapshots instanceof Map && turn.suggestionSnapshots.has(oldHash)) {
                const snapshots = this.suggestionSnapshotHistory(turn, oldHash);
                turn.suggestionSnapshots.delete(oldHash);
                snapshots.forEach(function (snapshot) { snapshot.pageHash = newHash; });
                turn.suggestionSnapshots.set(newHash, snapshots);
            }
            if (turn.feedbackSignatures instanceof Map && turn.feedbackSignatures.has(oldHash)) {
                const signature = turn.feedbackSignatures.get(oldHash);
                turn.feedbackSignatures.delete(oldHash);
                turn.feedbackSignatures.set(newHash, signature);
            }
        });
    }

    removePage(pageHash) {
        this.ipcRenderer.invoke('ai:page:remove', pageHash);
    }

    playHotkey(index) {
        if (this.mode !== 'ai') {
            return false;
        }

        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) && this.suggestions[index]) {
            this.playBlock(this.suggestions[index].hash);
        }

        return true;
    }

    clearConversation() {
        clearTimeout(this.provisionalTimer);
        clearTimeout(this.finalDeadlineTimer);
        this.provisionalTimer = null;
        this.finalDeadlineTimer = null;
        this.acceptTranscriptionEvents = false;
        this.tracker.clear();
        this.turns.clear();
        this.turnOrder = [];
        this.currentItemId = '';
        this.rankRequestId += 1;
        this.rankInFlight = false;
        this.pendingProvisional = null;
        this.pendingFinal = null;
        this.feedbackTombstones.clear();
        this.feedbackEpoch = 0;
        this.sessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        this.callState = createCallState();
        this.resetBilling();
        this.renderTranscript('', false);
        this.renderCallState();
        this.clearSuggestions();
        this.setStatus('stopped');
    }

    async destroy() {
        this.flushFeedback();
        await this.feedbackQueue;
        this.aiEnabled = false;
        this.mode = 'deck';
        await this.stopCapture();
        this.ipcRenderer.removeListener('ai:event', this.onAiEvent);
        document.removeEventListener('click', this.onDocumentClick);
        navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    }
}

module.exports = {AiController};
