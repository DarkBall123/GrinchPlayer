'use strict';

const {
    TranscriptTracker,
    buildContextText,
    isCurrentRanking,
    normalizeText
} = require('./ai-core');

const TOP_K = 5;
const PROVISIONAL_DEBOUNCE_MS = 700;
const FINAL_DEADLINE_MS = 1800;
const TRANSCRIPTION_COST_PER_MINUTE = 0.017;
const MAX_CALL_TURNS = 500;

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
        this.suggestions = [];
        this.rankInFlight = false;
        this.rankRequestId = 0;
        this.pendingProvisional = null;
        this.pendingFinal = null;
        this.provisionalTimer = null;
        this.lastProvisionalAt = 0;
        this.finalDeadlineTimer = null;
        this.indexPromise = null;
        this.feedbackQueue = Promise.resolve();
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
            scenarioSelect: document.querySelector('#ai-scenario-select'),
            scenarioName: document.querySelector('#ai-scenario-name'),
            scenarioPrompt: document.querySelector('#ai-scenario-prompt'),
            scenarioLabel: document.querySelector('#ai-scenario-label'),
            inputDevice: document.querySelector('#ai-input-device'),
            levelBar: document.querySelector('#ai-level-bar'),
            transcript: document.querySelector('#ai-transcript-text'),
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
        this.elements.inputDevice.addEventListener('change', () => this.changeInputDevice());
        this.elements.pauseButton.addEventListener('click', () => this.togglePause());
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
        this.clearConversation();
        if (this.activeScenario()) {
            if (this.paused) {
                await this.stopCapture();
                this.setStatus('paused');
            } else {
                await this.restartCapture();
            }
        } else {
            await this.stopCapture();
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
            this.ipcRenderer.send('ai:start');
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
        this.ipcRenderer.send('ai:stop');
        this.captureActive = false;
        this.pauseBilling();
        clearTimeout(this.provisionalTimer);
        clearTimeout(this.finalDeadlineTimer);
        this.provisionalTimer = null;
        this.finalDeadlineTimer = null;

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

    handleAudioPacket(pcm, level) {
        this.updateLevel(level);
        if (this.lastStatus === 'connected') {
            this.ipcRenderer.send('ai:audio', pcm);
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

    handleAiEvent(event) {
        if (!event) {
            return;
        }

        if (event.type === 'status') {
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

        const tracked = this.tracker.handle(event);
        if (!tracked) {
            return;
        }

        const turn = this.ensureTurn(tracked.itemId, tracked.startedAt || event.timestamp);
        turn.transcript = tracked.transcript;
        turn.completed = tracked.completed;

        if (event.type === 'speech_started') {
            this.beginTurn(turn);
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
            turn.context = buildContextText(this.historyFor(turn), turn.finalTranscript);
            this.saveFeedback(turn);

            if (this.shouldBeginTurn(turn)) {
                this.beginTurn(turn);
            }

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
                played: new Map()
            };
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
            .map((candidate) => ({
                turnId: candidate.turnId,
                transcript: candidate.finalTranscript,
                played: Array.from(candidate.played.values())
            }));
    }

    renderTranscript(text, final) {
        this.elements.transcript.textContent = normalizeText(text) || 'Ожидаю речь…';
        this.elements.transcript.classList.toggle('is-final', Boolean(final));
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
            if (!turn.rankingSettled && this.isTurnVisible(turn) && this.suggestions.length > 0) {
                this.renderSuggestions(this.suggestions, true, 'semantic');
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
                played: Array.from(turn.played.values()),
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
        this.renderSuggestions(result.suggestions, true, result.source);
    }

    renderSuggestions(suggestions, final, source) {
        const page = this.getPage();
        const candidates = new Map((page && page.candidates || []).map(function (candidate) {
            return [candidate.hash, candidate];
        }));
        const seen = new Set();
        this.suggestions = (suggestions || [])
            .filter(function (suggestion) {
                if (!suggestion || !candidates.has(suggestion.hash) || seen.has(suggestion.hash)) {
                    return false;
                }
                seen.add(suggestion.hash);
                return true;
            })
            .map(function (suggestion) { return candidates.get(suggestion.hash); })
            .slice(0, TOP_K);
        this.elements.suggestionList.replaceChildren();
        this.elements.suggestionStage.textContent = final ? (source === 'model' ? 'AI' : 'быстрый результат') : 'черновик';

        if (this.suggestions.length === 0) {
            this.clearSuggestions('Подходящих звуков не найдено');
            return;
        }

        this.suggestions.forEach(function (suggestion, index) {
            const button = document.createElement('button');
            button.className = 'button ai-suggestion' + (final ? ' is-final' : ' is-provisional');
            button.dataset.hash = suggestion.hash;

            const key = document.createElement('span');
            key.className = 'ai-suggestion-key';
            key.textContent = String(index + 1);
            const text = document.createElement('span');
            text.className = 'ai-suggestion-text';
            text.textContent = suggestion.text;

            button.append(key, text);
            this.elements.suggestionList.appendChild(button);
        }, this);
    }

    clearSuggestions(message) {
        this.suggestions = [];
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

        const playedKey = page.pageHash + '\u0000' + hash;
        turn.played.set(playedKey, {
            hash: hash,
            text: text,
            pageHash: page.pageHash,
            character: page.pageName || page.pageHash
        });
        if (turn.completed) {
            this.saveFeedback(turn);
        }
    }

    saveFeedback(turn) {
        if (!turn || !turn.completed || turn.played.size === 0 || !turn.context) {
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
            byPage.get(item.pageHash).push(item.hash);
        });

        byPage.forEach((blockHashes, pageHash) => {
            const payload = {
                turnId: turn.turnId + '\u0000' + pageHash,
                rootTurnId: turn.turnId,
                pageHash: pageHash,
                scenarioId: turn.scenarioId,
                context: turn.context,
                blockHashes: blockHashes
            };

            this.feedbackQueue = this.feedbackQueue
                .then(() => this.ipcRenderer.invoke('ai:feedback:save', payload))
                .then((stats) => this.renderFeedbackStats(stats))
                .catch(() => this.notify('Не удалось сохранить AI-пример', true, 2000));
        });
    }

    flushFeedback() {
        this.turns.forEach((turn) => this.saveFeedback(turn));
    }

    async refreshFeedbackStats() {
        const stats = await this.ipcRenderer.invoke('ai:feedback:stats');
        this.renderFeedbackStats(stats);
    }

    renderFeedbackStats(stats) {
        this.elements.feedbackCount.textContent = 'Примеров: ' + stats.unique + ' · выборов: ' + stats.selections;
        document.querySelector('#ai-feedback-undo').disabled = stats.turns === 0;
        document.querySelector('#ai-feedback-clear').disabled = stats.unique === 0;
    }

    async undoFeedback() {
        await this.feedbackQueue;
        const stats = await this.ipcRenderer.invoke('ai:feedback:undo');
        this.renderFeedbackStats(stats);
        this.notify('Последняя обучающая реплика отменена', false, 1800);
    }

    async clearFeedback() {
        if (this.confirm('Удалить все AI-примеры?') !== 1) {
            return;
        }

        await this.feedbackQueue;
        const stats = await this.ipcRenderer.invoke('ai:feedback:clear');
        this.renderFeedbackStats(stats);
        this.notify('AI-примеры очищены', false, 1800);
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
        this.turns.forEach(function (turn) {
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
        this.tracker.clear();
        this.turns.clear();
        this.turnOrder = [];
        this.currentItemId = '';
        this.rankRequestId += 1;
        this.rankInFlight = false;
        this.pendingProvisional = null;
        this.pendingFinal = null;
        this.sessionId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        this.resetBilling();
        this.renderTranscript('', false);
        this.clearSuggestions();
        this.setStatus('stopped');
    }

    async destroy() {
        this.flushFeedback();
        this.aiEnabled = false;
        this.mode = 'deck';
        await this.stopCapture();
        this.ipcRenderer.removeListener('ai:event', this.onAiEvent);
        document.removeEventListener('click', this.onDocumentClick);
        navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    }
}

module.exports = {AiController};
