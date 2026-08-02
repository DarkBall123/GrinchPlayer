'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {AiController} = require('../ai-renderer');
const {advanceCallState, createCallState} = require('../ai-core');

function createController(options) {
    return new AiController(Object.assign({
        ipcRenderer: {invoke: async function () {}},
        getPage: function () { return null; },
        getBlockText: function () { return ''; },
        playBlock: function () {},
        notify: function () {},
        confirm: function () { return 0; }
    }, options));
}

test('switching character keeps conversation history and reranks the current utterance', async function () {
    const page = {
        pageHash: 'character-b',
        pageName: 'Персонаж Б',
        candidates: [{hash: 'b', text: 'Ответ Б'}]
    };
    const controller = createController({getPage: function () { return page; }});
    controller.mode = 'ai';
    controller.aiEnabled = true;
    controller.captureActive = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';

    const previous = {
        itemId: 'previous',
        turnId: 'previous',
        pageHash: 'character-a',
        scenarioId: 'scenario',
        startedAt: 1,
        completed: true,
        finalTranscript: 'Предыдущая реплика',
        played: new Map([['a', {hash: 'a', text: 'Ответ А', pageHash: 'character-a'}]])
    };
    const current = {
        itemId: 'current',
        turnId: 'current',
        pageHash: 'character-a',
        scenarioId: 'scenario',
        startedAt: 2,
        transcript: 'Текущая реплика',
        finalTranscript: 'Текущая реплика',
        completed: true,
        revision: 3,
        rankingSettled: true,
        played: new Map()
    };
    controller.turns.set('previous', previous);
    controller.turns.set('current', current);
    controller.turnOrder = ['previous', 'current'];
    controller.currentItemId = 'current';
    controller.flushFeedback = function () {};
    controller.indexCurrentPage = async function () {};
    controller.clearSuggestions = function () {};
    controller.clearConversation = function () { throw new Error('conversation must be preserved'); };

    let rankingRequest;
    controller.requestRanking = function (turn, final) {
        rankingRequest = {turn: turn, final: final};
    };

    await controller.pageChanged();

    assert.equal(controller.turns.size, 2);
    assert.equal(current.pageHash, 'character-b');
    assert.equal(current.revision, 4);
    assert.equal(current.rankingSettled, false);
    assert.equal(rankingRequest.turn, current);
    assert.equal(rankingRequest.final, true);
    assert.deepEqual(controller.historyFor(current).map(function (turn) { return turn.turnId; }), ['previous']);
});

test('feedback from one utterance is grouped by character page', async function () {
    const payloads = [];
    const controller = createController({
        ipcRenderer: {
            invoke: async function (channel, payload) {
                payloads.push({channel: channel, payload: payload});
                return {unique: 2, selections: 2, turns: 1};
            }
        }
    });
    controller.renderFeedbackStats = function () {};

    controller.saveFeedback({
        turnId: 'turn',
        scenarioId: 'scenario',
        completed: true,
        context: 'Собеседник: общая реплика',
        played: new Map([
            ['a', {hash: 'a', text: 'Ответ А', pageHash: 'character-a'}],
            ['b', {hash: 'b', text: 'Ответ Б', pageHash: 'character-b'}]
        ])
    });
    await controller.feedbackQueue;

    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads.map(function (item) { return item.payload.pageHash; }), [
        'character-a',
        'character-b'
    ]);
    assert.equal(payloads.every(function (item) { return item.payload.rootTurnId === 'turn'; }), true);
});

test('transcript delta keeps updating while deck is visible', function () {
    const controller = createController({
        getPage: function () {
            return {pageHash: 'character', pageName: 'Персонаж', candidates: []};
        }
    });
    controller.mode = 'deck';
    controller.aiEnabled = true;
    controller.acceptTranscriptionEvents = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.clearSuggestions = function () {};
    let rendered = '';
    controller.renderTranscript = function (text) { rendered = text; };
    controller.scheduleProvisional = function () {};

    controller.handleAiEvent({
        type: 'transcript_delta',
        itemId: 'server-turn',
        delta: 'привет',
        timestamp: 100
    });

    assert.equal(controller.currentItemId, 'server-turn');
    assert.equal(controller.turns.get('server-turn').transcript, 'привет');
    assert.equal(rendered, 'привет');
});

test('pause stops capture and resumes without clearing conversation', async function () {
    const controller = createController();
    const icon = {className: ''};
    controller.elements = {
        pauseButton: {
            title: '',
            setAttribute: function () {},
            querySelector: function () { return icon; }
        }
    };
    controller.mode = 'ai';
    controller.aiEnabled = true;
    controller.turns.set('turn', {itemId: 'turn'});
    controller.turnOrder = ['turn'];
    controller.currentItemId = 'turn';
    controller.flushFeedback = function () {};
    controller.setStatus = function () {};
    let stopped = 0;
    let started = 0;
    controller.stopCapture = async function () { stopped += 1; };
    controller.startCapture = async function () { started += 1; };

    await controller.togglePause();
    assert.equal(controller.paused, true);
    assert.equal(stopped, 1);
    assert.equal(icon.className, 'fa fa-play');
    assert.equal(controller.turns.has('turn'), true);

    await controller.togglePause();
    assert.equal(controller.paused, false);
    assert.equal(started, 1);
    assert.equal(icon.className, 'fa fa-pause');
    assert.equal(controller.turns.has('turn'), true);
});

test('switching to deck keeps AI capture and conversation running', async function () {
    const classList = {add: function () {}, remove: function () {}};
    const controller = createController();
    controller.mode = 'ai';
    controller.aiEnabled = true;
    controller.elements = {
        deck: {classList: classList},
        aiTab: {classList: classList},
        deckTab: {classList: classList}
    };
    controller.turns.set('turn', {itemId: 'turn'});
    controller.turnOrder = ['turn'];
    controller.currentItemId = 'turn';
    controller.flushFeedback = function () {};
    let stopped = 0;
    controller.stopCapture = async function () { stopped += 1; };

    await controller.showDeck();

    assert.equal(controller.mode, 'deck');
    assert.equal(controller.aiEnabled, true);
    assert.equal(stopped, 0);
    assert.equal(controller.turns.has('turn'), true);
    assert.equal(controller.currentItemId, 'turn');
});

test('manual sound clicks are learned while deck is visible and AI keeps listening', function () {
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'answer', text: 'Ручной ответ'}]
    };
    const controller = createController({
        getPage: function () { return page; },
        getBlockText: function () { return 'Ручной ответ'; }
    });
    controller.mode = 'deck';
    controller.aiEnabled = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.currentItemId = 'turn';
    controller.turns.set('turn', {
        itemId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        completed: false,
        played: new Map()
    });

    controller.recordPlayed('answer');

    assert.equal(controller.turns.get('turn').played.size, 1);
    assert.equal(controller.turns.get('turn').played.values().next().value.hash, 'answer');
    assert.equal(controller.turns.get('turn').played.values().next().value.outsideTopK, null);
});

test('manual AI-visible choice records whether it was outside the shown top-five', function () {
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'manual', text: 'Ручной ответ'}]
    };
    const controller = createController({
        getPage: function () { return page; },
        getBlockText: function () { return 'Ручной ответ'; }
    });
    controller.mode = 'ai';
    controller.aiEnabled = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.currentItemId = 'turn';
    controller.suggestions = ['a', 'b', 'c', 'd', 'e'].map(function (hash) { return {hash: hash}; });
    controller.suggestionSource = 'semantic';
    controller.turns.set('turn', {
        itemId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        startedAt: Date.now() - 1000,
        completed: false,
        played: new Map(),
        playedEvents: [],
        suggestionSnapshots: new Map()
    });

    controller.recordPlayed('manual');
    const selection = controller.turns.get('turn').played.values().next().value;
    assert.equal(selection.outsideTopK, true);
    assert.deepEqual(selection.suggestedIds, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(selection.clickLatencyMs >= 900, true);
});

test('companion suggestion stays AI-visible while the main window shows the deck', function () {
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'answer', text: 'Ответ из подсказок'}]
    };
    const controller = createController({
        getPage: function () { return page; },
        getBlockText: function () { return 'Ответ из подсказок'; }
    });
    controller.mode = 'deck';
    controller.aiEnabled = true;
    controller.companionOpen = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.currentItemId = 'turn';
    controller.suggestions = [{hash: 'answer', text: 'Ответ из подсказок'}];
    controller.turns.set('turn', {
        itemId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        startedAt: Date.now() - 500,
        completed: false,
        played: new Map(),
        playedEvents: [],
        suggestionSnapshots: new Map()
    });

    controller.recordPlayed('answer');

    const selection = controller.turns.get('turn').played.values().next().value;
    assert.equal(selection.outsideTopK, false);
    assert.deepEqual(selection.suggestedIds, ['answer']);
});

test('companion can play only a suggestion from the current top-five', function () {
    const played = [];
    const controller = createController({playBlock: function (hash) { played.push(hash); }});
    controller.suggestions = [{hash: 'current', text: 'Текущая подсказка'}];

    controller.playCompanionSuggestion('stale');
    controller.playCompanionSuggestion('current');

    assert.deepEqual(played, ['current']);
});

test('unchanged completed turn is not written again on every deck switch', async function () {
    let saves = 0;
    const controller = createController({
        ipcRenderer: {
            invoke: async function (channel) {
                if (channel === 'ai:feedback:save') {
                    saves += 1;
                }
                return {unique: 0, selections: 0, turns: 0};
            }
        }
    });
    controller.renderFeedbackStats = function () {};
    const turn = {
        turnId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        finalTranscript: 'Алло',
        context: 'Собеседник: Алло',
        startedAt: 1,
        stoppedAt: 2,
        completed: true,
        played: new Map(),
        suggestionSnapshots: new Map(),
        feedbackSignatures: new Map()
    };

    controller.saveFeedback(turn);
    controller.saveFeedback(turn);
    await controller.feedbackQueue;
    assert.equal(saves, 1);
});

test('new call stops the old capture before clearing context and starting again', async function () {
    const order = [];
    const controller = createController({confirm: function () { return 1; }});
    controller.aiEnabled = true;
    controller.flushFeedback = function () { order.push('flush'); };
    controller.stopCapture = async function () { order.push('stop'); };
    controller.clearConversation = function () { order.push('clear'); };
    controller.startCapture = async function () { order.push('start'); };

    await controller.newCall();

    assert.deepEqual(order, ['flush', 'stop', 'clear', 'start']);
});

test('capture start sends the session token as the string expected by the main process', async function () {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
    const windowDescriptor = Object.getOwnPropertyDescriptor(global, 'window');
    const sends = [];
    const track = {addEventListener: function () {}, stop: function () {}};
    const stream = {
        getTracks: function () { return [track]; },
        getAudioTracks: function () { return [track]; }
    };
    class FakeAudioContext {
        constructor() {
            this.state = 'running';
            this.destination = {};
            this.audioWorklet = {addModule: async function () {}};
        }

        createMediaStreamSource() {
            return {connect: function () {}, disconnect: function () {}};
        }

        createGain() {
            return {gain: {value: 1}, connect: function () {}, disconnect: function () {}};
        }

        async close() {}
    }
    class FakeAudioWorkletNode {
        constructor() {
            this.port = {};
        }

        connect() {}
        disconnect() {}
    }

    Object.defineProperty(global, 'navigator', {
        configurable: true,
        value: {mediaDevices: {getUserMedia: async function () { return stream; }}}
    });
    Object.defineProperty(global, 'window', {
        configurable: true,
        value: {AudioContext: FakeAudioContext, AudioWorkletNode: FakeAudioWorkletNode}
    });
    try {
        const controller = createController({
            ipcRenderer: {
                send: function () { sends.push(Array.from(arguments)); },
                invoke: async function () {}
            },
            getPage: function () { return {pageHash: 'character', candidates: []}; }
        });
        controller.aiEnabled = true;
        controller.settings.hasKey = true;
        controller.settings.inputDeviceId = 'input';
        controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
        controller.settings.activeScenarioId = 'scenario';
        controller.elements = {
            status: {dataset: {}},
            statusText: {textContent: ''},
            sessionCost: {textContent: ''},
            levelBar: {style: {}}
        };
        controller.indexCurrentPage = async function () {};

        await controller.startCapture();

        const start = sends.find(function (args) { return args[0] === 'ai:start'; });
        assert.equal(typeof start[1], 'string');
        assert.equal(start[1], controller.captureSessionToken);
        await controller.stopCapture();
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(global, 'navigator', navigatorDescriptor);
        } else {
            delete global.navigator;
        }
        if (windowDescriptor) {
            Object.defineProperty(global, 'window', windowDescriptor);
        } else {
            delete global.window;
        }
    }
});

test('capture token rejects an old session and an older completed-only turn cannot replace current turn', function () {
    const controller = createController({
        getPage: function () {
            return {pageHash: 'character', pageName: 'Персонаж', candidates: []};
        }
    });
    controller.aiEnabled = true;
    controller.acceptTranscriptionEvents = true;
    controller.captureSessionToken = 'current-session';
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.clearSuggestions = function () {};
    controller.renderTranscript = function () {};
    controller.scheduleProvisional = function () {};

    controller.handleAiEvent({
        type: 'transcript_delta',
        sessionToken: 'old-session',
        itemId: 'old',
        delta: 'старый текст',
        timestamp: 10
    });
    assert.equal(controller.turns.size, 0);

    controller.handleAiEvent({
        type: 'transcript_delta',
        sessionToken: 'current-session',
        itemId: 'current',
        delta: 'новый текст',
        timestamp: 20
    });
    controller.handleAiEvent({
        type: 'transcript_completed',
        sessionToken: 'current-session',
        itemId: 'late-unknown',
        transcript: 'запоздалая старая реплика',
        timestamp: 10
    });

    assert.equal(controller.currentItemId, 'current-session\u0001current');
    assert.equal(controller.turns.get('current-session\u0001late-unknown').completed, true);
});

test('local item ids are isolated across capture sessions while completed history is preserved', function () {
    const controller = createController({
        getPage: function () {
            return {pageHash: 'character', pageName: 'Персонаж', candidates: []};
        }
    });
    controller.aiEnabled = true;
    controller.acceptTranscriptionEvents = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.clearSuggestions = function () {};
    controller.renderTranscript = function () {};
    controller.renderCallState = function () {};
    controller.saveFeedback = function () {};
    controller.linkTurnOutcomes = function () {};
    controller.requestRanking = function () {};
    controller.scheduleFinalDeadline = function () {};

    controller.captureSessionToken = 'session-1';
    controller.handleAiEvent({
        type: 'speech_started',
        sessionToken: 'session-1',
        itemId: 'local-1',
        timestamp: 100
    });
    controller.handleAiEvent({
        type: 'transcript_completed',
        sessionToken: 'session-1',
        itemId: 'local-1',
        transcript: 'Первая реплика',
        timestamp: 150
    });

    controller.captureSessionToken = 'session-2';
    controller.handleAiEvent({
        type: 'speech_started',
        sessionToken: 'session-2',
        itemId: 'local-1',
        timestamp: 200
    });

    assert.equal(controller.turns.size, 2);
    assert.equal(controller.turns.get('session-1\u0001local-1').completed, true);
    assert.equal(controller.turns.get('session-2\u0001local-1').completed, false);
    assert.equal(controller.currentItemId, 'session-2\u0001local-1');
});

test('a completed-only new turn is accepted when no delta was emitted', function () {
    const controller = createController({
        getPage: function () {
            return {pageHash: 'character', pageName: 'Персонаж', candidates: []};
        }
    });
    controller.aiEnabled = true;
    controller.acceptTranscriptionEvents = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.clearSuggestions = function () {};
    controller.renderTranscript = function () {};
    controller.renderCallState = function () {};
    controller.saveFeedback = function () {};
    controller.linkTurnOutcomes = function () {};
    controller.requestRanking = function () {};
    controller.scheduleFinalDeadline = function () {};

    controller.handleAiEvent({
        type: 'transcript_completed',
        itemId: 'complete-only',
        transcript: 'короткая реплика',
        timestamp: 50
    });

    assert.equal(controller.currentItemId, 'complete-only');
    assert.equal(controller.turns.get('complete-only').finalTranscript, 'короткая реплика');
});

test('recoverable transcription failure abandons only its dangling turn', function () {
    const notices = [];
    const controller = createController({notify: function (message) { notices.push(message); }});
    controller.aiEnabled = true;
    controller.currentItemId = 'failed';
    controller.turns.set('failed', {itemId: 'failed', closed: false});
    controller.clearSuggestions = function () {};
    controller.renderTranscript = function () {};

    controller.handleAiEvent({
        type: 'turn_failed',
        itemId: 'failed',
        error: {code: 'transcription_failed', message: 'Реплика не распознана'}
    });

    assert.equal(controller.currentItemId, '');
    assert.equal(controller.turns.get('failed').closed, true);
    assert.deepEqual(notices, ['Реплика не распознана']);
});

test('suggestion history keeps the first visible result when hidden deck rankings arrive', function () {
    const startedAt = Date.now() - 1000;
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'manual', text: 'Ручной ответ'}]
    };
    const controller = createController({
        getPage: function () { return page; },
        getBlockText: function () { return 'Ручной ответ'; }
    });
    controller.aiEnabled = true;
    controller.mode = 'ai';
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.currentItemId = 'turn';
    const turn = {
        itemId: 'turn',
        turnId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        startedAt: startedAt,
        completed: false,
        revision: 1,
        played: new Map(),
        playedEvents: [],
        suggestionSnapshots: new Map()
    };
    controller.turns.set('turn', turn);
    controller.suggestions = [{hash: 'visible'}];
    controller.suggestionSource = 'semantic';
    controller.captureSuggestionSnapshot();
    const firstVisible = controller.suggestionSnapshotHistory(turn, 'character')[0];
    firstVisible.shownAt = new Date(startedAt + 100).toISOString();

    controller.mode = 'deck';
    ['hidden-a', 'hidden-b', 'hidden-final'].forEach(function (hash, index) {
        controller.suggestions = [{hash: hash}];
        controller.suggestionsFinal = index === 2;
        controller.suggestionSource = index === 2 ? 'model' : 'semantic';
        turn.revision += 1;
        controller.captureSuggestionSnapshot();
    });

    const history = controller.suggestionSnapshotHistory(turn, 'character');
    assert.equal(history.length, 3);
    assert.equal(history.some(function (snapshot) { return snapshot === firstVisible; }), true);
    assert.equal(history.some(function (snapshot) { return snapshot.source === 'model' && !snapshot.visible; }), true);

    controller.mode = 'ai';
    controller.suggestions = [{hash: 'another'}];
    controller.recordPlayed('manual');
    const selection = turn.played.values().next().value;
    assert.equal(selection.suggestionLatencyMs, 100);
});

test('a stronger repeated manual click replaces weaker top-k attribution', function () {
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'manual', text: 'Ручной ответ'}]
    };
    const controller = createController({
        getPage: function () { return page; },
        getBlockText: function () { return 'Ручной ответ'; }
    });
    controller.aiEnabled = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.currentItemId = 'turn';
    const turn = {
        itemId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        startedAt: Date.now(),
        completed: false,
        played: new Map(),
        playedEvents: [],
        suggestionSnapshots: new Map()
    };
    controller.turns.set('turn', turn);

    controller.mode = 'deck';
    controller.recordPlayed('manual');
    controller.mode = 'ai';
    controller.suggestions = ['a', 'b', 'c', 'd', 'e'].map(function (hash) { return {hash: hash}; });
    controller.recordPlayed('manual');

    const selection = turn.played.values().next().value;
    assert.equal(selection.repeatCount, 2);
    assert.equal(selection.outsideTopK, true);
    assert.deepEqual(selection.suggestedIds, ['a', 'b', 'c', 'd', 'e']);
});

test('undo tombstones the local turn so a later flush cannot recreate it', async function () {
    let saves = 0;
    const controller = createController({
        ipcRenderer: {
            invoke: async function (channel) {
                if (channel === 'ai:feedback:save') {
                    saves += 1;
                    return {unique: 1, selections: 1, observations: 1, turns: 1};
                }
                if (channel === 'ai:feedback:undo') {
                    return {unique: 0, selections: 0, observations: 0, turns: 0, rootTurnId: 'turn'};
                }
            }
        }
    });
    controller.renderFeedbackStats = function () {};
    const turn = {
        turnId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        finalTranscript: 'Алло',
        context: 'Собеседник: Алло',
        startedAt: 1,
        stoppedAt: 2,
        completed: true,
        played: new Map([['answer', {hash: 'answer', blockHash: 'answer', pageHash: 'character'}]]),
        suggestionSnapshots: new Map(),
        feedbackSignatures: new Map()
    };
    controller.turns.set('turn', turn);
    controller.saveFeedback(turn);
    await controller.feedbackQueue;

    await controller.undoFeedback();
    turn.nextTranscript = 'Следующая реплика';
    controller.saveFeedback(turn);
    await controller.feedbackQueue;

    assert.equal(saves, 1);
    assert.equal(controller.feedbackTombstones.has('turn'), true);
});

test('clear tombstones current observations so later state changes cannot recreate them', async function () {
    let saves = 0;
    const controller = createController({
        confirm: function () { return 1; },
        ipcRenderer: {
            invoke: async function (channel) {
                if (channel === 'ai:feedback:save') {
                    saves += 1;
                    return {unique: 0, selections: 0, observations: 1, turns: 0};
                }
                if (channel === 'ai:feedback:clear') {
                    return {unique: 0, selections: 0, observations: 0, turns: 0};
                }
            }
        }
    });
    controller.renderFeedbackStats = function () {};
    const turn = {
        turnId: 'turn',
        scenarioId: 'scenario',
        pageHash: 'character',
        finalTranscript: 'Алло',
        context: 'Собеседник: Алло',
        startedAt: 1,
        stoppedAt: 2,
        completed: true,
        played: new Map(),
        suggestionSnapshots: new Map(),
        feedbackSignatures: new Map()
    };
    controller.turns.set('turn', turn);
    controller.saveFeedback(turn);
    await controller.feedbackQueue;

    await controller.clearFeedback();
    turn.nextTranscript = 'Следующая реплика';
    controller.saveFeedback(turn);
    await controller.feedbackQueue;

    assert.equal(saves, 1);
    assert.equal(controller.feedbackTombstones.has('turn'), true);
});

test('feedback stats count no-click observations and allow clearing them', function () {
    const originalDocument = global.document;
    const undo = {};
    const clear = {};
    global.document = {
        querySelector: function (selector) {
            return selector === '#ai-feedback-undo' ? undo : clear;
        }
    };
    try {
        const controller = createController();
        controller.elements = {feedbackCount: {textContent: ''}};
        controller.renderFeedbackStats({unique: 0, selections: 0, observations: 2, turns: 0});
        assert.match(controller.elements.feedbackCount.textContent, /ходов: 2/);
        assert.equal(undo.disabled, true);
        assert.equal(clear.disabled, false);
    } finally {
        global.document = originalDocument;
    }
});

test('a manual click after local speech start is attached to the turn completed later', async function () {
    const feedback = [];
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'answer', text: 'Ручной ответ'}]
    };
    const controller = createController({
        ipcRenderer: {
            invoke: async function (channel, payload) {
                if (channel === 'ai:feedback:save') {
                    feedback.push(payload);
                }
                return {unique: 1, selections: 1, observations: 1, turns: 1};
            }
        },
        getPage: function () { return page; },
        getBlockText: function () { return 'Ручной ответ'; }
    });
    controller.aiEnabled = true;
    controller.acceptTranscriptionEvents = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.clearSuggestions = function () {};
    controller.renderTranscript = function () {};
    controller.renderCallState = function () {};
    controller.renderFeedbackStats = function () {};
    controller.requestRanking = function () {};
    controller.scheduleFinalDeadline = function () {};

    controller.handleAiEvent({type: 'speech_started', itemId: 'local-turn', timestamp: 100});
    controller.recordPlayed('answer');
    controller.handleAiEvent({
        type: 'transcript_completed',
        itemId: 'local-turn',
        transcript: 'Алло, кто это?',
        timestamp: 500
    });
    await controller.feedbackQueue;

    assert.equal(controller.turns.get('local-turn').played.size, 1);
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].transcript, 'Алло, кто это?');
    assert.equal(feedback[0].selections[0].hash, 'answer');
});

test('full transcript snapshots replace previous provisional text instead of being appended', function () {
    const controller = createController({
        getPage: function () {
            return {pageHash: 'character', pageName: 'Персонаж', candidates: []};
        }
    });
    controller.aiEnabled = true;
    controller.acceptTranscriptionEvents = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.clearSuggestions = function () {};
    controller.renderTranscript = function () {};
    const provisional = [];
    controller.scheduleProvisional = function (turn) { provisional.push(turn.transcript); };

    controller.handleAiEvent({
        type: 'transcript_delta',
        itemId: 'local-turn',
        delta: 'при',
        transcript: 'при',
        timestamp: 100
    });
    controller.handleAiEvent({
        type: 'transcript_delta',
        itemId: 'local-turn',
        delta: 'привет',
        transcript: 'привет',
        timestamp: 100
    });

    assert.equal(controller.turns.get('local-turn').transcript, 'привет');
    assert.equal(controller.tracker.turns.get('local-turn').transcript, 'привет');
    assert.deepEqual(provisional, ['при', 'привет']);
});

test('a late earlier final rebuilds newer context and state and reranks current once', function () {
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'answer', text: 'Ответ'}]
    };
    const controller = createController({getPage: function () { return page; }});
    controller.mode = 'ai';
    controller.aiEnabled = true;
    controller.acceptTranscriptionEvents = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.clearSuggestions = function () {};
    controller.renderTranscript = function () {};
    controller.renderCallState = function () {};
    controller.scheduleFinalDeadline = function () {};
    controller.linkTurnOutcomes = function () {};
    const rankings = [];
    const feedback = [];
    controller.requestRanking = function (turn, final) { rankings.push({turn: turn, final: final}); };
    controller.saveFeedback = function (turn) { feedback.push(turn.itemId); };

    controller.handleAiEvent({type: 'speech_started', itemId: 'B', timestamp: 200});
    controller.handleAiEvent({
        type: 'transcript_completed',
        itemId: 'B',
        transcript: 'Почему вы звоните?',
        timestamp: 250
    });
    const turnB = controller.turns.get('B');
    const staleRevision = turnB.revision;
    turnB.rankingSettled = true;
    turnB.feedbackSignatures.set('character', 'stale');
    rankings.length = 0;
    feedback.length = 0;

    controller.handleAiEvent({type: 'speech_started', itemId: 'A', timestamp: 100});
    controller.handleAiEvent({
        type: 'transcript_completed',
        itemId: 'A',
        transcript: 'Алло.',
        timestamp: 150
    });

    assert.equal(controller.currentItemId, 'B');
    assert.equal(turnB.revision, staleRevision + 1);
    assert.equal(turnB.rankingSettled, false);
    assert.equal(turnB.context.indexOf('Собеседник: Алло.') <
        turnB.context.indexOf('Собеседник: Почему вы звоните?'), true);
    const expectedState = advanceCallState(
        advanceCallState(createCallState(), 'Алло.'),
        'Почему вы звоните?'
    );
    assert.deepEqual(controller.callState, expectedState);
    assert.deepEqual(rankings, [{turn: turnB, final: true}]);
    assert.deepEqual(feedback, ['B', 'A']);

    let rendered = 0;
    controller.renderSuggestions = function () { rendered += 1; };
    controller.applyRankingResult({
        final: true,
        turnId: turnB.turnId,
        pageHash: turnB.pageHash,
        revision: staleRevision,
        suggestions: [{hash: 'answer'}]
    });
    assert.equal(rendered, 0);
    assert.equal(turnB.rankingSettled, false);
});

test('clearing feedback during the current turn starts a new feedback epoch for future clicks', async function () {
    const channels = [];
    const page = {
        pageHash: 'character',
        pageName: 'Персонаж',
        candidates: [{hash: 'answer', text: 'Ручной ответ'}]
    };
    const controller = createController({
        confirm: function () { return 1; },
        ipcRenderer: {
            invoke: async function (channel) {
                channels.push(channel);
                return {unique: 0, selections: 0, observations: 0, turns: 0};
            }
        },
        getPage: function () { return page; },
        getBlockText: function () { return 'Ручной ответ'; }
    });
    controller.aiEnabled = true;
    controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'План'}];
    controller.settings.activeScenarioId = 'scenario';
    controller.renderFeedbackStats = function () {};
    const turn = {
        itemId: 'active',
        turnId: 'call:active',
        scenarioId: 'scenario',
        pageHash: 'character',
        startedAt: Date.now(),
        completed: true,
        closed: false,
        finalTranscript: 'Текущая реплика',
        context: 'Собеседник: Текущая реплика',
        stoppedAt: Date.now(),
        played: new Map([['old', {hash: 'old', pageHash: 'character'}]]),
        playedEvents: [],
        suggestionSnapshots: new Map(),
        feedbackSignatures: new Map()
    };
    controller.turns.set('active', turn);
    controller.currentItemId = 'active';

    await controller.clearFeedback();
    assert.equal(turn.played.size, 0);
    assert.equal(controller.feedbackTombstones.has('call:active'), true);
    assert.equal(turn.feedbackEligible, true);
    assert.equal(controller.feedbackTombstones.has(turn.feedbackRootId), false);

    controller.recordPlayed('answer');
    await controller.feedbackQueue;

    assert.deepEqual(channels, ['ai:feedback:clear', 'ai:feedback:save']);
    assert.match(turn.feedbackRootId, /:feedback:1$/);
    assert.equal(controller.feedbackTombstones.has(turn.feedbackRootId), false);
});

test('stopping capture closes only the unfinished UI turn and keeps completed history', async function () {
    const controller = createController({
        ipcRenderer: {send: function () {}, invoke: async function () {}}
    });
    controller.elements = {
        transcript: {},
        suggestionList: {},
        suggestionStage: {},
        levelBar: {style: {}}
    };
    const rendered = [];
    controller.renderTranscript = function (text, final) { rendered.push({text: text, final: final}); };
    controller.clearSuggestions = function () {};
    controller.pauseBilling = function () {};
    const previous = {
        itemId: 'previous',
        startedAt: 100,
        completed: true,
        finalTranscript: 'Предыдущая реплика'
    };
    const active = {itemId: 'active', startedAt: 200, completed: false, closed: false};
    controller.turns.set('previous', previous);
    controller.turns.set('active', active);
    controller.turnOrder = ['previous', 'active'];
    controller.currentItemId = 'active';

    await controller.stopCapture();

    assert.equal(active.closed, true);
    assert.equal(controller.currentItemId, '');
    assert.equal(controller.turns.get('previous'), previous);
    assert.deepEqual(rendered.at(-1), {text: 'Предыдущая реплика', final: true});
});

test('final deadline builds local suggestions when network ranking produced none', function () {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    let deadline;
    global.setTimeout = function (callback) {
        deadline = callback;
        return 1;
    };
    global.clearTimeout = function () {};
    try {
        const page = {
            pageHash: 'character',
            pageName: 'Персонаж',
            candidates: [
                {hash: 'a', text: 'Это я вам звоню.'},
                {hash: 'b', text: 'А вы кто такой?'},
                {hash: 'c', text: 'Не перебивайте меня.'},
                {hash: 'd', text: 'Что вы сказали?'},
                {hash: 'e', text: 'Я всё прекрасно слышу.'},
                {hash: 'f', text: 'До свидания.'}
            ]
        };
        const controller = createController({getPage: function () { return page; }});
        controller.aiEnabled = true;
        controller.settings.scenarios = [{id: 'scenario', name: 'Сценарий', prompt: 'Позвонить и выяснить имя'}];
        controller.settings.activeScenarioId = 'scenario';
        const turn = {
            itemId: 'turn',
            turnId: 'turn',
            scenarioId: 'scenario',
            pageHash: 'character',
            startedAt: 100,
            stoppedAt: Date.now(),
            transcript: 'Кто вы такая?',
            finalTranscript: 'Кто вы такая?',
            completed: true,
            rankingSettled: false,
            played: new Map()
        };
        controller.turns.set('turn', turn);
        controller.turnOrder = ['turn'];
        controller.currentItemId = 'turn';
        const rendered = [];
        controller.renderSuggestions = function (suggestions, final, source) {
            rendered.push({suggestions: suggestions, final: final, source: source});
        };

        controller.scheduleFinalDeadline(turn);
        deadline();

        assert.equal(rendered.length, 1);
        assert.equal(rendered[0].suggestions.length, 5);
        assert.equal(rendered[0].final, true);
        assert.equal(rendered[0].source, 'local');
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});
