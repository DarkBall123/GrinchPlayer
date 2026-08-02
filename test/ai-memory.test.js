'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    attachNextTranscript,
    createFeedbackState,
    migratePageFeedback,
    removePageFeedback,
    saveTurnFeedback,
    saveTurnObservation,
    undoLastTurn
} = require('../ai-memory');

function save(state, turnId, hashes, timestamp) {
    return saveTurnFeedback(state, {
        turnId: turnId,
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'Собеседник: проверка',
        blockHashes: hashes,
        embedding: [1, 0],
        updatedAt: timestamp
    });
}

test('all unique clicks in a turn are saved once', function () {
    let state = createFeedbackState();
    state = save(state, 'turn-1', ['a', 'a', 'b'], '2026-01-01T00:00:00.000Z');
    state = save(state, 'turn-1', ['a', 'b'], '2026-01-01T00:00:01.000Z');

    assert.equal(state.examples.length, 2);
    assert.deepEqual(state.examples.map(function (example) { return example.count; }), [1, 1]);
    assert.deepEqual(state.turnLog[0].blockHashes, ['a', 'b']);
});

test('same context and response across turns increments count and undo reverses one turn', function () {
    let state = createFeedbackState();
    state = save(state, 'turn-1', ['a'], '2026-01-01T00:00:00.000Z');
    state = save(state, 'turn-2', ['a'], '2026-01-01T00:01:00.000Z');

    assert.equal(state.examples[0].count, 2);
    state = undoLastTurn(state);
    assert.equal(state.examples[0].count, 1);
    assert.equal(state.turnLog.length, 1);
    assert.equal(state.rootTurnId, 'turn-2');
});

test('feedback can migrate with a renamed page and be removed with it', function () {
    let state = save(createFeedbackState(), 'turn-1', ['a'], '2026-01-01T00:00:00.000Z');
    state = migratePageFeedback(state, 'page', 'renamed');

    assert.equal(state.examples[0].pageHash, 'renamed');
    assert.equal(state.turnLog[0].pageHash, 'renamed');

    state = removePageFeedback(state, 'renamed');
    assert.equal(state.examples.length, 0);
    assert.equal(state.turnLog.length, 0);
});

test('feedback storage keeps at most the configured number of unique pairs', function () {
    let state = createFeedbackState();
    state = saveTurnFeedback(state, {
        turnId: 'turn-1',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'контекст',
        blockHashes: ['a', 'b', 'c'],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:00.000Z'
    }, 2);

    assert.equal(state.examples.length, 2);
});

test('feedback is isolated by both character page and prank scenario', function () {
    let state = createFeedbackState();
    state = saveTurnFeedback(state, {
        turnId: 'turn-a',
        pageHash: 'character-a',
        scenarioId: 'scenario-a',
        context: 'одинаковая реплика',
        blockHashes: ['sound'],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:00.000Z'
    });
    state = saveTurnFeedback(state, {
        turnId: 'turn-b',
        pageHash: 'character-a',
        scenarioId: 'scenario-b',
        context: 'одинаковая реплика',
        blockHashes: ['sound'],
        embedding: [1],
        updatedAt: '2026-01-01T00:01:00.000Z'
    });
    state = saveTurnFeedback(state, {
        turnId: 'turn-c',
        pageHash: 'character-b',
        scenarioId: 'scenario-a',
        context: 'одинаковая реплика',
        blockHashes: ['sound'],
        embedding: [1],
        updatedAt: '2026-01-01T00:02:00.000Z'
    });

    assert.equal(state.examples.length, 3);
    assert.equal(new Set(state.examples.map(function (example) { return example.scopeId; })).size, 3);
});

test('undo removes all character selections from the same conversation turn', function () {
    let state = createFeedbackState();
    state = saveTurnFeedback(state, {
        turnId: 'root-turn\u0000character-a',
        rootTurnId: 'root-turn',
        pageHash: 'character-a',
        scenarioId: 'scenario',
        context: 'общая реплика',
        blockHashes: ['sound-a'],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:00.000Z'
    });
    state = saveTurnFeedback(state, {
        turnId: 'root-turn\u0000character-b',
        rootTurnId: 'root-turn',
        pageHash: 'character-b',
        scenarioId: 'scenario',
        context: 'общая реплика',
        blockHashes: ['sound-b'],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:01.000Z'
    });

    assert.equal(state.examples.length, 2);
    state = undoLastTurn(state);
    assert.equal(state.examples.length, 0);
    assert.equal(state.turnLog.length, 0);
});

test('manual selection stores shown top-k, outside signal and click latency once', function () {
    let state = createFeedbackState();
    const payload = {
        turnId: 'turn',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'Собеседник: кто это?',
        selections: [{
            blockHash: 'manual',
            pageHash: 'page',
            suggestedIds: ['a', 'b', 'c', 'd', 'e'],
            outsideTopK: true,
            clickLatencyMs: 820,
            callState: {phase: 'engagement'}
        }],
        embedding: [1, 0],
        updatedAt: '2026-01-01T00:00:00.000Z'
    };
    state = saveTurnFeedback(state, payload);
    state = saveTurnFeedback(state, payload);

    assert.equal(state.examples[0].count, 1);
    assert.equal(state.examples[0].outsideTopKCount, 1);
    assert.deepEqual(state.examples[0].lastSuggestedIds, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(state.examples[0].lastClickLatencyMs, 820);
});

test('a stronger repeated click updates the same turn without double-counting it', function () {
    let state = createFeedbackState();
    const payload = {
        turnId: 'turn',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'Собеседник: кто это?',
        selections: [{blockHash: 'manual', outsideTopK: null, repeatCount: 1}],
        embedding: [1, 0],
        updatedAt: '2026-01-01T00:00:00.000Z'
    };
    state = saveTurnFeedback(state, payload);
    state = saveTurnFeedback(state, Object.assign({}, payload, {
        selections: [{
            blockHash: 'manual',
            outsideTopK: true,
            suggestedIds: ['a', 'b', 'c', 'd', 'e'],
            clickLatencyMs: 900,
            repeatCount: 2
        }],
        updatedAt: '2026-01-01T00:00:01.000Z'
    }));

    assert.equal(state.examples[0].count, 1);
    assert.equal(state.examples[0].outsideTopKCount, 1);
    assert.equal(state.examples[0].shownSelectionCount, 0);
    assert.equal(state.examples[0].lastRepeatCount, 2);
    assert.deepEqual(state.turnLog[0].selections[0].suggestedIds, ['a', 'b', 'c', 'd', 'e']);

    state = undoLastTurn(state);
    assert.equal(state.examples.length, 0);
});

test('no-click observation is retained for evaluation but creates no preference example', function () {
    const state = saveTurnObservation(createFeedbackState(), {
        turnId: 'turn\u0000page',
        rootTurnId: 'turn',
        pageHash: 'page',
        scenarioId: 'scenario',
        transcript: 'алло',
        context: 'Собеседник: алло',
        suggestionSnapshots: [{pageHash: 'page', ids: ['a', 'b'], visible: true}],
        selections: [],
        updatedAt: '2026-01-01T00:00:00.000Z'
    });

    assert.equal(state.observations.length, 1);
    assert.equal(state.observations[0].suggestionSnapshots[0].visible, true);
    assert.equal(state.examples.length, 0);
    assert.equal(state.turnLog.length, 0);
});

test('next interlocutor utterance updates outcome without increasing preference count', function () {
    let state = saveTurnFeedback(createFeedbackState(), {
        turnId: 'turn\u0000page',
        rootTurnId: 'turn',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'Собеседник: кто это?',
        blockHashes: ['answer'],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:00.000Z'
    });
    state = attachNextTranscript(state, 'turn', 'А откуда вы звоните?');

    assert.equal(state.examples[0].count, 1);
    assert.equal(state.examples[0].nextTranscript, 'А откуда вы звоните?');
});

test('undo reverses the stronger outside-top-k signal', function () {
    let state = saveTurnFeedback(createFeedbackState(), {
        turnId: 'turn',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'контекст',
        selections: [{blockHash: 'answer', outsideTopK: true}],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:00.000Z'
    });
    state = undoLastTurn(state);

    assert.equal(state.examples.length, 0);
    assert.equal(state.turnLog.length, 0);
});

test('undo restores the complete example snapshot from before the latest selection', function () {
    let state = saveTurnFeedback(createFeedbackState(), {
        turnId: 'turn-1',
        rootTurnId: 'turn-1',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'одинаковый контекст',
        selections: [{
            blockHash: 'answer',
            outsideTopK: false,
            suggestedIds: ['answer'],
            clickLatencyMs: 400,
            callState: {phase: 'engagement'}
        }],
        embedding: [1, 0],
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z'
    });
    state = attachNextTranscript(state, 'turn-1', 'первый исход');
    const previousExample = JSON.parse(JSON.stringify(state.examples[0]));

    state = saveTurnFeedback(state, {
        turnId: 'turn-2',
        rootTurnId: 'turn-2',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'одинаковый контекст',
        selections: [{
            blockHash: 'answer',
            outsideTopK: true,
            suggestedIds: ['other'],
            clickLatencyMs: 900,
            callState: {phase: 'escalation'}
        }],
        embedding: [0, 1],
        startedAt: '2026-01-01T00:01:00.000Z',
        updatedAt: '2026-01-01T00:01:01.000Z'
    });
    state = attachNextTranscript(state, 'turn-2', 'отменяемый исход');
    state = undoLastTurn(state);

    assert.deepEqual(state.examples[0], previousExample);
    assert.deepEqual(state.turnLog.map(function (log) { return log.rootTurnId; }), ['turn-1']);
});

test('undo selects the chronologically latest root turn and removes all of its noncontiguous page logs', function () {
    let state = createFeedbackState();
    state = saveTurnFeedback(state, {
        turnId: 'new-turn\u0000page-a',
        rootTurnId: 'new-turn',
        pageHash: 'page-a',
        scenarioId: 'scenario',
        context: 'новый ход',
        blockHashes: ['new-a'],
        embedding: [1],
        startedAt: '2026-01-01T00:02:00.000Z',
        updatedAt: '2026-01-01T00:02:01.000Z'
    });
    state = saveTurnFeedback(state, {
        turnId: 'old-turn\u0000page-a',
        rootTurnId: 'old-turn',
        pageHash: 'page-a',
        scenarioId: 'scenario',
        context: 'старый ход завершился позже',
        blockHashes: ['old'],
        embedding: [1],
        startedAt: '2026-01-01T00:01:00.000Z',
        updatedAt: '2026-01-01T00:03:00.000Z'
    });
    state = saveTurnFeedback(state, {
        turnId: 'new-turn\u0000page-b',
        rootTurnId: 'new-turn',
        pageHash: 'page-b',
        scenarioId: 'scenario',
        context: 'новый ход',
        blockHashes: ['new-b'],
        embedding: [1],
        startedAt: '2026-01-01T00:02:00.000Z',
        updatedAt: '2026-01-01T00:02:02.000Z'
    });

    state = undoLastTurn(state);

    assert.deepEqual(state.turnLog.map(function (log) { return log.rootTurnId; }), ['old-turn']);
    assert.deepEqual(state.examples.map(function (example) { return example.blockHash; }), ['old']);
});
