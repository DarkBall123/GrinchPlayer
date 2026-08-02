'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {AiController} = require('../ai-renderer');

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

test('transcript delta starts a turn without server VAD events', function () {
    const controller = createController({
        getPage: function () {
            return {pageHash: 'character', pageName: 'Персонаж', candidates: []};
        }
    });
    controller.mode = 'ai';
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

test('switching to deck stops capture without clearing conversation', async function () {
    const classList = {add: function () {}, remove: function () {}};
    const controller = createController();
    controller.mode = 'ai';
    controller.elements = {
        deck: {classList: classList},
        aiTab: {classList: classList},
        deckTab: {classList: classList}
    };
    controller.turns.set('turn', {itemId: 'turn'});
    controller.turnOrder = ['turn'];
    controller.currentItemId = 'turn';
    controller.flushFeedback = function () {};
    controller.stopCapture = async function () {};

    await controller.showDeck();

    assert.equal(controller.mode, 'deck');
    assert.equal(controller.turns.has('turn'), true);
    assert.equal(controller.currentItemId, 'turn');
});
